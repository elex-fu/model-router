import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetch as undiciFetch } from 'undici';
import { DispatchCompletionTracker } from './dispatch-completion-test-helper.js';
import {
  createFinancialNetworkFaultFixture, INVALID_JSON_USAGE_VARIANTS, type InvalidJsonUsageVariant,
} from './commercial-gateway-financial-fault-fixture.js';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import {
  createProviderCredentialContext,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  DEPLOYMENT_ENV_VARS,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
  MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  parseDeploymentConfig,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../../../src/saas/deployment.js';
import {
  type CustomerMeteringPolicyDefinition,
  canonicalContractAttestationPayload,
  type ProviderMeteringPolicyDefinition,
  SaasCommercialMeteringPolicyService,
} from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { DispatchUsageSettlementCoordinator } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresRequestPreparationAuthorityAdapter } from '../../../src/saas/gateway/postgres-request-preparation-authority-adapter.js';
import { ProviderAccountScheduler, type ProviderAccountSchedulerHealthDecision } from '../../../src/saas/gateway/provider-account-scheduler.js';
import {
  SaasPreparedEvidenceDispatchError,
  type PreparedEvidenceDispatchErrorCode,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import {
  SaasPreparedRequestEvidenceError,
  SaasPreparedRequestEvidenceService,
  type PreparedRequestEvidenceErrorCode,
  type PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { SaasProjectInferencePolicyService } from '../../../src/saas/gateway/project-policy-service.js';
import {
  PostgresProviderAccountLeaseService,
  ProviderAccountLeaseError,
  type ProviderAccountLeaseErrorCode,
} from '../../../src/saas/gateway/provider-account-lease-service.js';
import { createProviderHttpTestAddressCapability } from '../../../src/saas/gateway/provider-http-address.js';
import {
  ProviderHttpTransport,
  ProviderHttpTransportError,
  type ProviderHttpTransportErrorCode,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  allowRequestPreparation,
  type RequestPreparationDecision,
  type RequestPreparationEntitlementPort,
  type RequestPreparationFailureCode,
  type RequestPreparationStage,
  rejectRequestPreparation,
} from '../../../src/saas/gateway/request-preparation-service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { PostgresSupplyProfileResolver } from '../../../src/saas/keys/resolver.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import { SaasKeyError } from '../../../src/saas/keys/types.js';
import { SaasMeteringError, type SaasMeteringErrorCode } from '../../../src/saas/metering/errors.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import { ByokServicePlanService } from '../../../src/saas/plans/service.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import type {
  ManagedSaasGatewayRuntimeDependencies,
  ManagedSaasGatewayRuntimeModuleOptions,
} from '../../../src/saas/runtime/gateway-runtime-module.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from '../../../src/saas/runtime/prepared-evidence-verifier-keys.js';
import { PreparedRequestEvidenceSigner } from '../../../src/saas/runtime/prepared-request-evidence-signer.js';
import { createProviderTargetResolver } from '../../../src/saas/runtime/provider-target-resolver.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type { ProviderSupplyOwner } from '../../../src/saas/supply/types.js';
import type { ManagedSaasRuntime } from '../../../src/server/managed-saas.js';
import { SAAS_PLATFORM_AUDIT_CURSOR_SECRET, startManagedSaasServer } from '../../../src/server/managed-saas.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const MIGRATOR_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL';
const CONTROL_PLANE_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL';
const GATEWAY_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL';
const ENDPOINT = '/v1/chat/completions';
const PROVIDER_SECRET = 'gateway-e2e-provider-secret';
const PLATFORM_PROVIDER_SECRET = 'gateway-e2e-platform-provider-secret';
const DEK = new Uint8Array(32).fill(0x37);
const usageBounds = {
  inputTotalUpperBound: 16,
  inputUncachedUpperBound: 16,
  cacheReadUpperBound: 0,
  cacheWriteUpperBound: 0,
  cacheWrite5mUpperBound: 0,
  cacheWrite1hUpperBound: 0,
  outputTotalUpperBound: 16,
  reasoningOutputUpperBound: 0,
  feasibleInputBuckets: ['input'],
} as const;

const roleUrls = {
  migrator: process.env[MIGRATOR_URL],
  controlPlane: process.env[CONTROL_PLANE_URL],
  gateway: process.env[GATEWAY_URL],
};
const hasAllRoleUrls = Object.values(roleUrls).every((value) => typeof value === 'string' && value.trim() !== '');

const SAFE_PREPARATION_SQL_STATES = new Set([
  '42501', '23502', '23503', '23505', '23514', '22023', '22P02', '40001', '40P01',
  '42P01', '42P08', '42703', '42883', '55000', '55P03', '57014',
]);

interface SafePreparationDiagnostic {
  readonly outcome: 'blocked' | 'rejected';
  readonly reason: 'preparation_result';
  readonly stage: RequestPreparationStage | 'unrecognized_stage';
  readonly code: RequestPreparationFailureCode | 'unrecognized_code';
  readonly sqlStates: readonly string[];
  readonly boundaries: readonly SafePreparationBoundary[];
}

interface SafePreparationBoundary {
  readonly port: 'authority' | 'scheduler' | 'health';
  readonly decision: 'allow' | 'reject' | 'deny' | 'block' | 'threw' | 'unrecognized_decision';
  readonly code: RequestPreparationFailureCode | 'unrecognized_code' | null;
  readonly reason:
    | 'eligibility_unavailable' | 'eligibility_invalid_candidate' | 'health_unavailable'
    | 'concurrency_unavailable' | 'concurrency_invalid'
    | 'health_unknown' | 'health_stale_or_malformed' | 'health_input_invalid'
    | 'health_authority_unavailable' | 'health_prior_write_failure' | 'unknown';
}

interface SafeUpstreamMatches {
  readonly methodPost: boolean;
  readonly endpointMatches: boolean;
  readonly hasAuthHeader: boolean;
  readonly expectedBYOKBearerMatches: boolean;
  readonly expectedPlatformBearerMatches: boolean;
  readonly rawBYOKSecretMatches: boolean;
  readonly rawPlatformSecretMatches: boolean;
}

function observePreparationFailures(
  runtime: ManagedSaasRuntime,
  report: (diagnostic: SafePreparationDiagnostic) => void,
): () => SafePreparationDiagnostic | null {
  assert.ok(runtime.gateway, 'the real managed gateway composition must be present');
  const stages = new Set<RequestPreparationStage>(['caller', 'entitlement', 'authority', 'payload', 'admission', 'attempt', 'evidence', 'dispatch']);
  const codes = new Set<RequestPreparationFailureCode>([
    'invalid_input', 'proxy_key_invalid', 'proxy_key_disabled', 'caller_denied', 'entitlement_denied',
    'quota_exceeded', 'rate_limited', 'hold_denied', 'route_denied', 'account_denied', 'payload_invalid',
    'payload_bounds_unavailable', 'capability_unavailable', 'canonicalization_failed', 'signing_failed',
    'attempt_persistence_failed', 'evidence_registration_failed', 'binding_mismatch', 'idempotency_conflict',
    'idempotency_replay', 'client_cancelled', 'dispatch_failed', 'storage_failure',
  ]);
  const observations = new AsyncLocalStorage<{ sqlStates: Set<string>; boundaries: SafePreparationBoundary[] }>();
  let lastFailure: SafePreparationDiagnostic | null = null;
  const recordSqlState = (error: unknown) => {
    // Never inspect message/detail/context/stack, SQL text, parameters, caller
    // or payload. A diagnostic must not change the real error or result.
    try {
      const code: unknown = error !== null && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (typeof code === 'string' && SAFE_PREPARATION_SQL_STATES.has(code)) {
        observations.getStore()?.sqlStates.add(code);
      }
    } catch { /* Diagnostic projection cannot replace the original failure. */ }
  };
  const observeExecutor = (executor: SqlExecutor): SqlExecutor => ({
    async query<Row>(sql: string, values?: readonly unknown[]) {
      try { return await executor.query<Row>(sql, values); }
      catch (error) { recordSqlState(error); throw error; }
    },
  });
  const database = runtime.database;
  const realQuery = database.query.bind(database);
  const realTransaction = database.transaction.bind(database);
  database.query = observeExecutor({ query: realQuery }).query;
  database.transaction = async <T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
    try { return await realTransaction((executor) => work(observeExecutor(executor))); }
    catch (error) { recordSqlState(error); throw error; }
  };
  const preparation = runtime.gateway.preparation;
  const dependenciesDescriptor = Object.getOwnPropertyDescriptor(preparation, 'dependencies');
  assert.ok(dependenciesDescriptor && Object.hasOwn(dependenciesDescriptor, 'value'));
  const dependencies: unknown = dependenciesDescriptor.value;
  assert.ok(dependencies !== null && typeof dependencies === 'object');
  const dependency = (name: 'authority' | 'scheduler'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
  };
  const authority = dependency('authority');
  const scheduler = dependency('scheduler');
  assert.ok(authority instanceof PostgresRequestPreparationAuthorityAdapter);
  assert.ok(scheduler instanceof PostgresProviderAccountScheduler);
  const nativeSchedulerDescriptor = Object.getOwnPropertyDescriptor(scheduler, 'scheduler');
  assert.ok(nativeSchedulerDescriptor && Object.hasOwn(nativeSchedulerDescriptor, 'value'));
  const nativeScheduler: unknown = nativeSchedulerDescriptor.value;
  assert.ok(nativeScheduler instanceof ProviderAccountScheduler);
  const schedulerDependenciesDescriptor = Object.getOwnPropertyDescriptor(nativeScheduler, 'dependencies');
  assert.ok(schedulerDependenciesDescriptor && Object.hasOwn(schedulerDependenciesDescriptor, 'value'));
  const schedulerDependencies: unknown = schedulerDependenciesDescriptor.value;
  assert.ok(schedulerDependencies !== null && typeof schedulerDependencies === 'object');
  const healthDescriptor = Object.getOwnPropertyDescriptor(schedulerDependencies, 'health');
  assert.ok(healthDescriptor && Object.hasOwn(healthDescriptor, 'value'));
  const nativeHealth: unknown = healthDescriptor.value;
  assert.ok(nativeHealth instanceof PostgresProviderAccountRuntimeHealthStore);
  const recordBoundary = (
    port: SafePreparationBoundary['port'],
    result: RequestPreparationDecision<unknown> | 'threw',
  ): void => {
    try {
      const context = observations.getStore();
      if (!context || context.boundaries.length >= 4) return;
      let reason: SafePreparationBoundary['reason'] = 'unknown';
      if (port === 'scheduler' && result !== 'threw' && result.decision === 'block' &&
          result.code === 'capability_unavailable') {
        // Compare only exact native block literals; never forward the message.
        const message = result.message;
        if (message === 'PostgreSQL provider eligibility authority is unavailable') {
          reason = 'eligibility_unavailable';
        } else if (message === 'provider eligibility authority returned an invalid candidate') {
          reason = 'eligibility_invalid_candidate';
        } else if (message === 'provider account health authority is unavailable' ||
                   message === 'runtime health authority is missing: the SaaS schema has no account health/cooldown observation contract; validation_state is not runtime health') {
          reason = 'health_unavailable';
        } else if (message === 'provider account lease concurrency snapshot is unavailable' ||
                   message === 'provider account lease concurrency authority is unavailable' ||
                   message === 'provider account lease concurrency limit is missing; configure the same maxConcurrency as the lease service') {
          reason = 'concurrency_unavailable';
        } else if (message === 'provider account concurrency authority returned an invalid decision' ||
                   message === 'provider account concurrency authority is invalid' ||
                   message === 'provider account lease concurrency snapshot is malformed') {
          reason = 'concurrency_invalid';
        }
      }
      context.boundaries.push({
        port,
        decision: result === 'threw' ? 'threw' :
          result.decision === 'allow' || result.decision === 'reject' || result.decision === 'block'
            ? result.decision : 'unrecognized_decision',
        code: result === 'threw' ? 'unrecognized_code' : result.decision === 'allow' ? null :
          codes.has(result.code) ? result.code : 'unrecognized_code',
        reason,
      });
    } catch { /* Enum-only observation cannot change a native decision or exception. */ }
  };
  const recordHealthBoundary = (result: ProviderAccountSchedulerHealthDecision | 'threw'): void => {
    try {
      const context = observations.getStore();
      if (!context || context.boundaries.length >= 4) return;
      let reason: SafePreparationBoundary['reason'] = 'unknown';
      if (result !== 'threw' && result.decision === 'block') {
        // Only fixed native reasons; never inspect an allowed value or timestamp.
        if (result.reason === 'provider account runtime health is unknown') {
          reason = 'health_unknown';
        } else if (result.reason === 'provider account runtime health is stale or malformed') {
          reason = 'health_stale_or_malformed';
        } else if (result.reason === 'provider account runtime health input is invalid') {
          reason = 'health_input_invalid';
        } else if (result.reason === 'provider account runtime health authority is unavailable') {
          const descriptor = Object.getOwnPropertyDescriptor(nativeHealth, 'writeFailed');
          const writeFailed: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
          if (typeof writeFailed === 'boolean') {
            reason = writeFailed === true ? 'health_prior_write_failure' : 'health_authority_unavailable';
          }
        }
      }
      context.boundaries.push({
        port: 'health',
        decision: result === 'threw' ? 'threw' :
          result.decision === 'allow' || result.decision === 'deny' || result.decision === 'block'
            ? result.decision : 'unrecognized_decision',
        code: result === 'threw' ? 'unrecognized_code' : null,
        reason,
      });
    } catch { /* Enum-only observation cannot change native health results or exceptions. */ }
  };
  const observeBoundary = async <T>(
    port: SafePreparationBoundary['port'],
    work: () => Promise<RequestPreparationDecision<T>>,
  ): Promise<RequestPreparationDecision<T>> => {
    try {
      const result = await work();
      recordBoundary(port, result);
      return result;
    } catch (error) { recordBoundary(port, 'threw'); throw error; }
  };
  const realResolve = authority.resolve.bind(authority);
  const realSelect = scheduler.select.bind(scheduler);
  authority.resolve = (...args) => observeBoundary('authority', () => realResolve(...args));
  scheduler.select = (...args) => observeBoundary('scheduler', () => realSelect(...args));
  const realHealthGet = nativeHealth.get.bind(nativeHealth);
  nativeHealth.get = async (...args) => {
    try {
      const result = await realHealthGet(...args);
      recordHealthBoundary(result);
      return result;
    } catch (error) { recordHealthBoundary('threw'); throw error; }
  };
  const realPrepare = preparation.prepare.bind(preparation);
  // The HTTP handler retains this exact core-owned instance. Delegate to its
  // real coordinator and unchanged ports, then project only allowlisted enums.
  preparation.prepare = (input) => observations.run({ sqlStates: new Set<string>(), boundaries: [] }, async () => {
    const result = await realPrepare(input);
    if (result.outcome === 'blocked' || result.outcome === 'rejected') {
      lastFailure = {
        outcome: result.outcome,
        reason: 'preparation_result',
        stage: stages.has(result.stage) ? result.stage : 'unrecognized_stage',
        code: codes.has(result.code) ? result.code : 'unrecognized_code',
        sqlStates: [...observations.getStore()!.sqlStates].sort(),
        boundaries: [...observations.getStore()!.boundaries],
      };
      try { report(lastFailure); } catch { /* Reporting cannot change preparation. */ }
    }
    return result;
  });
  return () => lastFailure;
}

type SafeDispatchStage =
  | 'dispatch' | 'evidence_preflight' | 'evidence_claim' | 'attempt_read' | 'attempt_transition'
  | 'known_http_transition' | 'lease_acquire' | 'lease_renew' | 'lease_release'
  | 'transport_send' | 'settlement_complete' | 'settlement_retain_unknown';
interface SafeDispatchError {
  readonly stage: SafeDispatchStage;
  readonly source: 'dispatch' | 'evidence' | 'lease' | 'transition' | 'transport' | 'unrecognized_error';
  readonly code: PreparedEvidenceDispatchErrorCode | PreparedRequestEvidenceErrorCode |
    ProviderAccountLeaseErrorCode | SaasMeteringErrorCode | ProviderHttpTransportErrorCode | 'unrecognized_code';
}
interface SafeDispatchDiagnostic {
  readonly outcome: 'threw' | 'unknown' | 'lease_release_failed';
  readonly errors: readonly SafeDispatchError[];
  readonly sqlStates: readonly string[];
}

function observeDispatchFailures(
  runtime: ManagedSaasRuntime,
  completions: DispatchCompletionTracker,
  report: (diagnostic: SafeDispatchDiagnostic) => void,
): () => SafeDispatchDiagnostic | null {
  assert.ok(runtime.gateway, 'dispatch diagnostics require the real core-owned gateway composition');
  const dispatchCodes = new Set<PreparedEvidenceDispatchErrorCode>([
    'INVALID_INPUT', 'ATTEMPT_NOT_FOUND', 'ATTEMPT_NOT_READY', 'EVIDENCE_BINDING_MISMATCH',
    'LEASE_UNAVAILABLE', 'LEASE_RELEASE_FAILED', 'CLIENT_STREAM_FAILED', 'CLIENT_STREAM_ABORTED',
    'DISPATCH_STATE_CONFLICT', 'STATE_UPDATE_FAILED', 'UNKNOWN_STATE_UPDATE_FAILED',
  ]);
  const evidenceCodes = new Set<PreparedRequestEvidenceErrorCode>([
    'INVALID_INPUT', 'UNKNOWN_VERIFIER_KEY', 'SIGNATURE_INVALID', 'EXPIRED', 'AUTHORITY_MISMATCH',
    'NOT_FOUND', 'ALREADY_CLAIMED', 'STORAGE_ERROR', 'AUDIT_FAILED',
  ]);
  const leaseCodes = new Set<ProviderAccountLeaseErrorCode>([
    'INVALID_INPUT', 'ACCOUNT_UNAVAILABLE', 'LEASE_UNAVAILABLE', 'STALE_LEASE', 'STORAGE_ERROR',
  ]);
  const transitionCodes = new Set<SaasMeteringErrorCode>([
    'METERING_INVALID_INPUT', 'METERING_STORAGE_ERROR', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_TOMBSTONED',
    'REQUEST_NOT_FOUND', 'ATTEMPT_NOT_FOUND', 'ATTEMPT_ORDINAL_CONFLICT', 'ATTEMPT_TRANSITION_INVALID',
    'REQUEST_TRANSITION_INVALID', 'USAGE_EVENT_NOT_FOUND', 'USAGE_DUPLICATE_CONFLICT', 'USAGE_SETTLEMENT_CONFLICT',
  ]);
  const transportCodes = new Set<ProviderHttpTransportErrorCode>([
    'INVALID_INPUT', 'PROFILE_UNAVAILABLE', 'PROFILE_INVALID', 'ENDPOINT_POLICY_VIOLATION',
    'PAYLOAD_BINDING_MISMATCH', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_INVALID', 'ABORTED',
    'TIMEOUT', 'NETWORK_ERROR', 'REDIRECT_REJECTED', 'INVALID_RESPONSE',
  ]);
  const allowedSqlStates = new Set([
    '42501', '23502', '23503', '23505', '23514', '22023', '22P02', '40001', '40P01',
    '42P01', '42P08', '42703', '42883', '55000', '55P03', '57014',
  ]);
  interface Observation {
    readonly stage: SafeDispatchStage;
    readonly errors: SafeDispatchError[];
    readonly sqlStates: Set<string>;
  }
  // Independent from preparation and from every other request/workflow. Values
  // below are static enums only; never message/detail/context/stack/SQL/values,
  // payload, request/key identities, credential data, or provider URLs.
  const observations = new AsyncLocalStorage<Observation>();
  let lastFailure: SafeDispatchDiagnostic | null = null;
  const recordFailure = (error: unknown): void => {
    const observation = observations.getStore();
    if (!observation) return;
    try {
      const seen = new Set<object>();
      let current: unknown = error;
      for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
        if (seen.has(current)) break;
        seen.add(current);
        let projected: SafeDispatchError | undefined;
        const stage = observation.stage;
        if (current instanceof SaasPreparedEvidenceDispatchError && dispatchCodes.has(current.code)) {
          projected = { stage, source: 'dispatch', code: current.code };
        } else if (current instanceof SaasPreparedRequestEvidenceError && evidenceCodes.has(current.code)) {
          projected = { stage, source: 'evidence', code: current.code };
        } else if (current instanceof ProviderAccountLeaseError && leaseCodes.has(current.code)) {
          projected = { stage, source: 'lease', code: current.code };
        } else if (current instanceof SaasMeteringError && transitionCodes.has(current.code)) {
          projected = { stage, source: 'transition', code: current.code };
        } else if (current instanceof ProviderHttpTransportError && transportCodes.has(current.code)) {
          projected = { stage, source: 'transport', code: current.code };
        }
        const code: unknown = Object.getOwnPropertyDescriptor(current, 'code')?.value;
        if (typeof code === 'string' && allowedSqlStates.has(code)) observation.sqlStates.add(code);
        if (!projected && depth === 0) projected = { stage, source: 'unrecognized_error', code: 'unrecognized_code' };
        const candidate = projected;
        if (candidate && observation.errors.length < 32 && !observation.errors.some((entry) =>
          entry.stage === candidate.stage && entry.source === candidate.source && entry.code === candidate.code)) {
          observation.errors.push(candidate);
        }
        // Only an own data cause is traversed; no getters or arbitrary object graph.
        const cause = Object.getOwnPropertyDescriptor(current, 'cause');
        current = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
      }
    } catch { /* Projection must never replace the real exception. */ }
  };
  const phase = <T>(stage: SafeDispatchStage, work: () => Promise<T>): Promise<T> => {
    const observation = observations.getStore();
    if (!observation) return work();
    return observations.run({ ...observation, stage }, async () => {
      try { return await work(); }
      catch (error) { recordFailure(error); throw error; }
    });
  };
  const observeExecutor = (executor: SqlExecutor): SqlExecutor => ({
    async query<Row>(sql: string, values?: readonly unknown[]) {
      try { return await executor.query<Row>(sql, values); }
      catch (error) { recordFailure(error); throw error; }
    },
  });
  const database = runtime.database;
  const realQuery = database.query.bind(database);
  const realTransaction = database.transaction.bind(database);
  database.query = observeExecutor({ query: realQuery }).query;
  database.transaction = async <T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
    try { return await realTransaction((executor) => work(observeExecutor(executor))); }
    catch (error) { recordFailure(error); throw error; }
  };

  const dispatcher = runtime.gateway.dispatch;
  // These are the existing constructor-owned objects, not replacement ports.
  // Read only fixed dependency data properties and require their real classes.
  const dependency = (name: 'evidence' | 'metering' | 'leaseProvider' | 'transport' | 'normalSuccessSettlement'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(dispatcher, name);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'), 'core dispatch dependency must be an own data property');
    return descriptor.value;
  };
  const evidence = dependency('evidence');
  const metering = dependency('metering');
  const leases = dependency('leaseProvider');
  const transport = dependency('transport');
  const settlement = dependency('normalSuccessSettlement');
  assert.ok(evidence instanceof SaasPreparedRequestEvidenceService);
  assert.ok(metering instanceof SaasMeteringService);
  assert.ok(leases instanceof PostgresProviderAccountLeaseService);
  assert.ok(transport instanceof ProviderHttpTransport);
  assert.ok(settlement instanceof DispatchUsageSettlementCoordinator);
  const preflight = evidence.preflightForDispatch.bind(evidence);
  const claim = evidence.claimForDispatch.bind(evidence);
  const getAttempt = metering.getAttempt.bind(metering);
  const transition = metering.transitionAttempt.bind(metering);
  const knownHttp = metering.recordKnownNonSuccessHttpResponse.bind(metering);
  const acquire = leases.acquire.bind(leases);
  const send = transport.send.bind(transport);
  const complete = settlement.complete.bind(settlement);
  const retainUnknown = settlement.retainUnknown.bind(settlement);
  evidence.preflightForDispatch = (...args) => phase('evidence_preflight', () => preflight(...args));
  evidence.claimForDispatch = (...args) => phase('evidence_claim', () => claim(...args));
  metering.getAttempt = (...args) => phase('attempt_read', () => getAttempt(...args));
  metering.transitionAttempt = (...args) => phase('attempt_transition', () => transition(...args));
  metering.recordKnownNonSuccessHttpResponse = (...args) => phase('known_http_transition', () => knownHttp(...args));
  leases.acquire = (...args) => phase('lease_acquire', async () => {
    const lease = await acquire(...args);
    if (lease) {
      const renew = lease.renew.bind(lease);
      const release = lease.release.bind(lease);
      lease.renew = () => phase('lease_renew', renew);
      lease.release = () => phase('lease_release', release);
    }
    return lease; // Exact real lease object; fencing/cadence/identity are unchanged.
  });
  transport.send = (...args) => phase('transport_send', () => send(...args));
  settlement.complete = (...args) => phase('settlement_complete', () => complete(...args));
  settlement.retainUnknown = (...args) => phase('settlement_retain_unknown', () => retainUnknown(...args));

  const realDispatch = dispatcher.dispatch.bind(dispatcher);
  const publish = (outcome: SafeDispatchDiagnostic['outcome']): void => {
    const observation = observations.getStore();
    if (!observation) return;
    lastFailure = { outcome, errors: [...observation.errors], sqlStates: [...observation.sqlStates].sort() };
    try { report(lastFailure); } catch { /* Reporting cannot change dispatch. */ }
  };
  dispatcher.dispatch = (input) => {
    const pending = observations.run({ stage: 'dispatch', errors: [], sqlStates: new Set<string>() }, async () => {
      try {
        const result = await realDispatch(input);
        if (result.kind === 'unknown') {
          recordFailure(result.error);
          publish('unknown');
        } else if (result.leaseReleaseError) {
          recordFailure(result.leaseReleaseError);
          publish('lease_release_failed');
        }
        return result;
      } catch (error) {
        recordFailure(error);
        publish('threw');
        throw error;
      }
    });
    // The handler's audit request ID is the response x-request-id, not the
    // canonical ID returned by an idempotency replay. Observe this exact call;
    // return its unchanged promise so the real handler still sees every error.
    completions.track(input.audit.requestId, pending, (result) => result.leaseReleaseError
      ? 'lease_release_failed' : result.kind === 'unknown' ? 'unknown' : 'sent');
    return pending;
  };
  return () => lastFailure;
}

async function freeLocalPort(used: Set<number>): Promise<number> {
  for (;;) {
    const reservation = createNetServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('could not reserve a local test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });
    if (!used.has(port)) {
      used.add(port);
      return port;
    }
  }
}

async function closeHttpServer(server: { close(callback: (error?: Error) => void): unknown; listening: boolean }) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listenerEnvironment(name: 'customer' | 'platform' | 'gateway', port: number) {
  const config = DEPLOYMENT_ENV_VARS.listeners[name];
  return {
    [config.bindAddress]: '127.0.0.1',
    [config.port]: String(port),
    [config.origin]: `http://127.0.0.1:${port}`,
  };
}

function assertRoleUrl(name: string, value: string | undefined, username: string): asserts value is string {
  assert.equal(typeof value, 'string', `${name} is required when the real gateway E2E gate is enabled`);
  if (typeof value !== 'string') return;
  const parsed = new URL(value);
  assert.ok(parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:', `${name} must be PostgreSQL`);
  assert.equal(decodeURIComponent(parsed.username), username, `${name} must connect as ${username}`);
}

async function walletSnapshot(database: ReturnType<typeof createSaasDatabase>, tenantId: string) {
  const result = await database.query<{
    wallets: string;
    wallet_balance: string;
    billing_reservations: string;
    ledger_transactions: string;
    ledger_entries: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM saas_wallets WHERE tenant_id = $1) AS wallets,
       (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS wallet_balance,
       (SELECT count(*)::text FROM saas_billing_reservations WHERE tenant_id = $1) AS billing_reservations,
       (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = $1) AS ledger_transactions,
       (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS ledger_entries`,
    [tenantId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function gatewayEffectSnapshot(database: ReturnType<typeof createSaasDatabase>, tenantId: string) {
  const result = await database.query<{
    requests: string;
    attempts: string;
    prepared_evidence: string;
    usage_events: string;
    usage_settlements: string;
    price_snapshots: string;
    active_hold: string;
    capacity: unknown[];
    provider_leases: unknown[];
    idempotency: unknown[];
  }>(
    `SELECT
       (SELECT count(*)::text FROM saas_requests WHERE tenant_id = $1) AS requests,
       (SELECT count(*)::text FROM saas_attempts WHERE tenant_id = $1) AS attempts,
       (SELECT count(*)::text FROM saas_prepared_request_evidence WHERE tenant_id = $1) AS prepared_evidence,
       (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1) AS usage_events,
       (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1) AS usage_settlements,
       (SELECT count(*)::text FROM saas_request_customer_price_snapshots WHERE tenant_id = $1) AS price_snapshots,
       (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_billing_reservations
         WHERE tenant_id = $1 AND state IN ('reserved', 'reconciliation_pending')) AS active_hold,
       (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.request_id), '[]'::jsonb)
          FROM saas_gateway_capacity_reservations c WHERE c.tenant_id = $1) AS capacity,
       (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
          FROM saas_provider_account_leases l WHERE l.tenant_id = $1) AS provider_leases,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.request_id), '[]'::jsonb)
          FROM saas_gateway_request_idempotency_keys i WHERE i.tenant_id = $1) AS idempotency`,
    [tenantId],
  );
  assert.equal(result.rows.length, 1);
  return { wallet: await walletSnapshot(database, tenantId), effects: result.rows[0]! };
}

test('real PostgreSQL commercial gateway E2E launches managed control-plane and gateway runtimes and pins local HTTPS upstream', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !hasAllRoleUrls
      ? `set ${REQUIRED_FLAG}=1 and the three role URLs to require the live PostgreSQL gate`
      : false,
}, async (t) => {
  assertRoleUrl(MIGRATOR_URL, roleUrls.migrator, 'model_router_saas_migrator');
  assertRoleUrl(CONTROL_PLANE_URL, roleUrls.controlPlane, 'model_router_saas_control_plane');
  assertRoleUrl(GATEWAY_URL, roleUrls.gateway, 'model_router_saas_gateway');

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let tempDirectory: string | undefined;
  let upstream: HttpsServer | undefined;
  let controlPlaneRuntime: ManagedSaasRuntime | undefined;
  let gatewayRuntime: ManagedSaasRuntime | undefined;
  let seedDatabase: ReturnType<typeof createSaasDatabase> | undefined;
  let controlPlaneProbe: ReturnType<typeof createSaasDatabase> | undefined;
  let gatewayProbe: ReturnType<typeof createSaasDatabase> | undefined;
  const dispatchCompletions = new DispatchCompletionTracker();
  const financialFaults = createFinancialNetworkFaultFixture({ waitTimeoutMs: 5_000 });

  try {
    const migration = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MODEL_ROUTER_SAAS_DATABASE_URL: roleUrls.migrator,
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(
      migration.status,
      0,
      `registered SaaS migrations through the managed CLI must succeed (exit=${migration.status}, signal=${migration.signal ?? 'none'})`,
    );

    seedDatabase = createSaasDatabase({ connectionString: roleUrls.migrator, max: 2 });
    controlPlaneProbe = createSaasDatabase({ connectionString: roleUrls.controlPlane, max: 1 });
    gatewayProbe = createSaasDatabase({ connectionString: roleUrls.gateway, max: 1 });
    await seedDatabase.verifySchema();
    for (const [database, role] of [
      [controlPlaneProbe, 'control_plane'],
      [gatewayProbe, 'gateway'],
    ] as const) {
      const current = await database.query<{ current_user: string }>('SELECT current_user');
      assert.equal(current.rows[0]?.current_user, `model_router_saas_${role}`);
      await verifySaasRuntimeDatabasePrivileges(database, role);
    }

    tempDirectory = await mkdtemp(join(tmpdir(), 'managed-saas-gateway-e2e-'));
    const certificatePath = join(tempDirectory, 'test-ca-and-server.crt');
    const privateKeyPath = join(tempDirectory, 'test-server.key');
    const certificate = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-sha256',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(certificate.status, 0, 'OpenSSL must generate a local test-only TLS CA/server certificate');
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(certificatePath, 'utf8'),
      readFile(privateKeyPath, 'utf8'),
    ]);

    let upstreamCallCount = 0;
    let upstreamMatches: SafeUpstreamMatches | null = null;
    let upstreamAuthorization: string | undefined;
    const upstreamAuthorizations: string[] = [];
    const upstreamStreams: boolean[] = [];
    const upstreamResponse = [
      'data: {"id":"chatcmpl-gateway-e2e","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"e2e-ok"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-gateway-e2e","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const acceptedUpstreamAuthorizations = new Set([`Bearer ${PROVIDER_SECRET}`, `Bearer ${PLATFORM_PROVIDER_SECRET}`]);
    upstream = createHttpsServer({ cert: certificatePem, key: privateKeyPem }, (request, response) => {
      upstreamCallCount += 1;
      upstreamAuthorization = request.headers.authorization;
      upstreamAuthorizations.push(upstreamAuthorization ?? '');
      // Passive projection only: never retain or print path/header values here.
      upstreamMatches = {
        methodPost: request.method === 'POST',
        endpointMatches: request.url === ENDPOINT,
        hasAuthHeader: upstreamAuthorization !== undefined,
        expectedBYOKBearerMatches: upstreamAuthorization === `Bearer ${PROVIDER_SECRET}`,
        expectedPlatformBearerMatches: upstreamAuthorization === `Bearer ${PLATFORM_PROVIDER_SECRET}`,
        rawBYOKSecretMatches: upstreamAuthorization === PROVIDER_SECRET,
        rawPlatformSecretMatches: upstreamAuthorization === PLATFORM_PROVIDER_SECRET,
      };
      if (
        request.method !== 'POST' ||
        request.url !== ENDPOINT ||
        !acceptedUpstreamAuthorizations.has(upstreamAuthorization ?? '')
      ) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":"unexpected local test request"}');
        return;
      }
      let requestBody = '';
      request.setEncoding('utf8');
      request.on('error', () => response.destroy());
      request.on('data', (chunk: string) => {
        requestBody += chunk;
        if (Buffer.byteLength(requestBody) > 64 * 1024) {
          response.writeHead(413, { 'content-type': 'application/json' });
          response.end('{"error":"local test payload is too large"}');
          request.destroy();
        }
      });
      request.on('end', () => {
        if (response.writableEnded || response.destroyed) return;
        let payload: { stream?: unknown; model?: unknown };
        try {
          payload = JSON.parse(requestBody);
          if (!payload || typeof payload !== 'object' || typeof payload.stream !== 'boolean') {
            throw new Error('the local test upstream requires an explicit stream flag');
          }
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end('{"error":"invalid local test JSON request"}');
          return;
        }
        upstreamStreams.push(payload.stream as boolean);
        if (financialFaults.handle(request, response, payload)) return;
        if (payload.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          response.end(upstreamResponse);
        } else {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
          response.end(JSON.stringify({
            id: 'chatcmpl-gateway-e2e-json', object: 'chat.completion', created: 1, model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'e2e-ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }));
        }
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
    const upstreamPort = upstreamAddress.port;

    const ids = { label: randomUUID().replaceAll('-', '') };
    const tenantSlug = `gateway-e2e-${ids.label}`;
    const providerId = `gateway-e2e-provider-${ids.label}`;
    const productId = `gateway-e2e-product-${ids.label}`;
    const providerModel = `gateway-e2e-provider-model-${ids.label}`;
    const publicModel = `gateway-e2e-model-${ids.label}`;
    const publicModelId = randomUUID();
    const profileId = `gateway-e2e-profile-${ids.label}`;
    const platformProfileId = `gateway-e2e-platform-profile-${ids.label}`;
    const platformEntitlementId = randomUUID();
    const upstreamId = `gateway-e2e-upstream-${ids.label}`;
    const accountId = `gateway-e2e-account-${ids.label}`;
    const credentialId = `gateway-e2e-credential-${ids.label}`;
    const platformAccountId = `gateway-e2e-platform-account-${ids.label}`;
    const platformCredentialId = `gateway-e2e-platform-credential-${ids.label}`;
    const platformPoolId = `gateway-e2e-platform-pool-${ids.label}`;
    const rightsId = `gateway-e2e-rights-${ids.label}`;
    const platformRightsId = `gateway-e2e-platform-rights-${ids.label}`;
    const routeId = `gateway-e2e-route-${ids.label}`;
    const platformRouteId = `gateway-e2e-platform-route-${ids.label}`;
    const servicePlanId = `gateway-e2e-plan-${ids.label}`;
    const planVersionId = randomUUID();
    const deploymentId = 'managed-saas-gateway-e2e';
    const environmentId = 'test';
    const now = new Date();
    const nowIso = now.toISOString();
    const audit = {
      actorUserId: '',
      requestId: randomUUID(),
      entryPoint: 'managed-saas-gateway-real-postgres-e2e',
    };

    const identity = new SaasIdentityService(seedDatabase);
    const bootstrap = await identity.issueBootstrapToken();
    const administrator = await identity.bootstrapPlatformAdmin({
      token: bootstrap.token,
      email: `gateway-e2e-${ids.label}@example.test`,
      displayName: 'Gateway E2E Administrator',
      password: `e2e-${randomUUID()}-Strong-Password!`,
    });
    audit.actorUserId = administrator.id;
    const tenant = await identity.createTenant(administrator.id, {
      name: `Gateway E2E ${ids.label}`,
      slug: tenantSlug,
    });
    const project = await identity.createProject(administrator.id, tenant.id, {
      name: `Gateway E2E Project ${ids.label}`,
      slug: `gateway-e2e-project-${ids.label}`,
    });
    const tenantContext = await identity.resolveTenantContext({
      userId: administrator.id,
      tenantId: tenant.id,
      projectId: project.id,
    });

    const projectPolicy = await new SaasProjectInferencePolicyService(seedDatabase).enable({
      tenantId: tenant.id,
      projectId: project.id,
      expectedVersion: 1,
      audit,
    });
    await seedDatabase.query(
      `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, 'byok', 'active', $3, 1, $4, $4, $4)`,
      [tenant.id, profileId, [publicModel], nowIso],
    );
    await seedDatabase.query(
      `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, 'platform', 'active', $3, 1, $4, $4, $4)`,
      [tenant.id, platformProfileId, [publicModel], nowIso],
    );
    const entitlementEffectiveAt = new Date(now.getTime() - 60_000).toISOString();
    const entitlementExpiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    await seedDatabase.query(
      `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, status, model_scopes,
            authz_version, created_at, updated_at, last_audited_at, effective_at, expires_at, source_type)
         VALUES ($1, $2, $3, $4, 'platform', 'active', $5, 1, $6, $6, $6, $7, $8, 'admin_grant')`,
      [
        platformEntitlementId,
        tenant.id,
        project.id,
        platformProfileId,
        [publicModel],
        nowIso,
        entitlementEffectiveAt,
        entitlementExpiresAt,
      ],
    );
    await seedDatabase.query(
      `INSERT INTO saas_service_plans (id, slug, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'published', $4, $4)`,
      [servicePlanId, `gateway-e2e-${ids.label}`, 'Gateway E2E BYOK service plan', nowIso],
    );
    await seedDatabase.query(
      `INSERT INTO saas_service_plan_versions
           (id, plan_id, version, supply_mode, supply_profile_id, allowed_provider_ids, allowed_models,
            price_version, price_minor_units, currency, term_days, policy_version, status, created_at, published_at)
         VALUES ($1, $2, 1, 'byok', $3, $4, $5, $6, 100, 'USD', 30, $7, 'published', $8, $8)`,
      [
        planVersionId,
        servicePlanId,
        profileId,
        [providerId],
        [publicModel],
        `price-${ids.label}`,
        `policy-${ids.label}`,
        nowIso,
      ],
    );
    const plans = new ByokServicePlanService(seedDatabase);
    const order = await plans.createOrder(tenantContext, {
      planVersionId,
      clientRequestId: `gateway-e2e-order-${ids.label}`,
    });
    const checkoutOrder = await seedDatabase.query<{ id: string }>(
      `UPDATE saas_service_plan_orders
          SET provider_key = $3,
              merchant_id = $4,
              provider_order_id = $5
        WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
        RETURNING id`,
      [
        tenant.id,
        order.id,
        'gateway-e2e-settlement-provider',
        'gateway-e2e-merchant',
        `gateway-e2e-provider-order-${ids.label}`,
      ],
    );
    assert.deepEqual(
      checkoutOrder.rows.map(({ id }) => id),
      [order.id],
      'the E2E fixture must bind a provider checkout order before verified settlement fulfillment',
    );
    const fulfilled = await plans.fulfillVerified({
      kind: 'server_verified_service_plan_fulfillment',
      orderId: order.id,
      tenantId: tenant.id,
      projectId: project.id,
      settlementId: `gateway-e2e-settlement-${ids.label}`,
      providerKey: 'gateway-e2e-settlement-provider',
      merchantId: 'gateway-e2e-merchant',
      amountMinorUnits: '100',
      currency: 'USD',
      fulfillmentReference: `gateway-e2e-fulfillment-${ids.label}`,
      fulfillmentEvidenceSha256: 'e'.repeat(64),
      verifiedAt: now,
    });
    const effectiveEntitlement = await plans.resolveBoundForRequest(
      { tenantId: tenant.id, projectId: project.id },
      fulfilled.entitlementId,
    );
    assert.ok(effectiveEntitlement, 'fulfilled BYOK service plan must resolve from PostgreSQL');
    assert.deepEqual(effectiveEntitlement.allowedProviderIds, [providerId]);

    const catalog = new SaasCatalogService(seedDatabase);
    await catalog.registerProviderProduct({ providerId, productId, displayName: 'Gateway E2E Provider Product' });
    await catalog.registerPublicModelAlias({
      publicModelId,
      alias: publicModel,
      displayName: 'Gateway E2E Public Model',
      providerId,
      productId,
      model: providerModel,
      endpointScope: [ENDPOINT],
    });
    const capability = await catalog.registerProviderCapability({
      providerId,
      productId,
      model: providerModel,
      endpoint: ENDPOINT,
      protocol: 'openai',
      supportLevel: 'supported',
      validationState: 'verified',
      evidenceVersion: 'gateway-e2e-capability-v1',
      discoverySource: 'manual',
      evidenceReference: `gateway-e2e-capability-${ids.label}`,
      evidenceSha256: 'a'.repeat(64),
    });
    const rights = await catalog.registerProviderRightsVersion({
      rightsId,
      providerId,
      productId,
      credentialType: 'api-key',
      supplyMode: 'byok',
      region: 'e2e-region',
      purpose: 'inference',
      modelScope: [providerModel],
      endpointScope: [ENDPOINT],
      effectiveAt: new Date(now.getTime() - 60_000).toISOString(),
      approvalReference: `gateway-e2e-approval-${ids.label}`,
      status: 'active',
      evidenceReference: `gateway-e2e-rights-evidence-${ids.label}`,
      evidenceSha256: 'b'.repeat(64),
      audit,
    });
    const platformRights = await catalog.registerProviderRightsVersion({
      rightsId: platformRightsId,
      providerId,
      productId,
      credentialType: 'api-key',
      supplyMode: 'platform',
      region: 'e2e-region',
      purpose: 'inference',
      modelScope: [providerModel],
      endpointScope: [ENDPOINT],
      effectiveAt: entitlementEffectiveAt,
      approvalReference: `gateway-e2e-platform-approval-${ids.label}`,
      status: 'active',
      evidenceReference: `gateway-e2e-platform-rights-evidence-${ids.label}`,
      evidenceSha256: '9'.repeat(64),
      audit,
    });

    const customerDefinition: CustomerMeteringPolicyDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      customerPriceVersion: null,
      usageDimensions: ['input_total', 'output_total'],
      tokenSource: 'upstream',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      commercialPolicyVersion: 'gateway-e2e-commercial-v1',
    };
    const providerDefinition: ProviderMeteringPolicyDefinition = {
      ...customerDefinition,
      providerId,
      productId,
      resolvedModel: providerModel,
      supplierCostVersion: null,
    };
    const contractKeyPair = generateKeyPairSync('ed25519');
    const contractKeyId = `gateway-e2e-contract-${ids.label}`;
    const testVectorDigest = 'c'.repeat(64);
    const commercial = new SaasCommercialMeteringPolicyService(seedDatabase, {
      trustedVerifierPublicKeys: new Map([[contractKeyId, contractKeyPair.publicKey]]),
      trustedTestVectorDigests: new Map([['gateway-e2e-suite-v1', testVectorDigest]]),
    });
    const customerPolicyId = `gateway-e2e-customer-policy-${ids.label}`;
    const providerPolicyId = `gateway-e2e-provider-policy-${ids.label}`;
    await commercial.createCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: customerPolicyId,
      definition: customerDefinition,
      audit,
    });
    await commercial.createProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: providerPolicyId,
      definition: providerDefinition,
      audit,
    });
    const customerPolicy = await commercial.publishCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: customerPolicyId,
      expectedVersion: 1,
      definition: customerDefinition,
      audit,
    });
    const providerPolicy = await commercial.publishProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: providerPolicyId,
      expectedVersion: 1,
      definition: providerDefinition,
      audit,
    });
    const contractDigest = 'd'.repeat(64);
    const attestationPayload = canonicalContractAttestationPayload({
      contractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      publicModelId,
      publicModelVersion: '1',
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      usageDimensions: customerDefinition.usageDimensions,
      tokenSource: customerDefinition.tokenSource,
      roundingVersion: customerDefinition.roundingVersion,
      roundingMode: customerDefinition.roundingMode,
      roundingBoundary: 'total',
    });
    const attestationId = `gateway-e2e-attestation-${ids.label}`;
    await commercial.attestProviderContract({
      tenantId: tenant.id,
      projectId: project.id,
      id: attestationId,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      contractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      verifierKeyId: contractKeyId,
      signatureBase64: sign(null, Buffer.from(attestationPayload), contractKeyPair.privateKey).toString('base64'),
      usageDimensions: customerDefinition.usageDimensions,
      tokenSource: customerDefinition.tokenSource,
      roundingVersion: customerDefinition.roundingVersion,
      roundingMode: customerDefinition.roundingMode,
      roundingBoundary: 'total',
      audit,
    });

    const routes = new SaasRouteConfigService(seedDatabase);
    const routeDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai' as const,
      supplyMode: 'byok' as const,
      targetMode: 'tenant_account' as const,
      upstreamId,
      endpoint: ENDPOINT,
    };
    await routes.create({ tenantId: tenant.id, projectId: project.id, routeId, definition: routeDefinition, audit });
    const activeRoute = await routes.publish({
      tenantId: tenant.id,
      projectId: project.id,
      routeId,
      expectedVersion: 1,
      definition: routeDefinition,
      audit,
    });
    await commercial.bindRoute({
      tenantId: tenant.id,
      projectId: project.id,
      routeId,
      routeVersion: activeRoute.version,
      customerPolicyId,
      customerPolicyVersion: customerPolicy.version,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      contractAttestationId: attestationId,
      audit,
    });

    const pricing = new SaasPricingService(seedDatabase);
    const platformCustomerPrice = await pricing.appendCustomerPriceVersion({
      publicModelId,
      publicModelVersion: 1,
      providerId,
      productId,
      protocol: 'openai',
      endpoint: ENDPOINT,
      currency: 'USD',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
      calculatorVersion: 'gateway-e2e-calculator-v1',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      rates: {
        input: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_read: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write_5m: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write_1h: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 3, denominatorUnits: 1 },
      },
      effectiveAt: entitlementEffectiveAt,
      idempotencyKey: `gateway-e2e-platform-customer-price-${ids.label}`,
    });
    const platformSupplierCost = await pricing.appendSupplierCostVersion({
      publicModelId,
      publicModelVersion: 1,
      providerId,
      productId,
      resolvedModel: providerModel,
      protocol: 'openai',
      endpoint: ENDPOINT,
      currency: 'USD',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
      calculatorVersion: 'gateway-e2e-calculator-v1',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      rates: {
        input: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_read: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_5m: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_1h: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 1, denominatorUnits: 1 },
      },
      effectiveAt: entitlementEffectiveAt,
      idempotencyKey: `gateway-e2e-platform-supplier-cost-${ids.label}`,
    });
    const platformCustomerDefinition: CustomerMeteringPolicyDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      customerPriceVersion: platformCustomerPrice.id,
      usageDimensions: ['input_total', 'output_total'],
      tokenSource: 'upstream',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
    };
    const platformProviderDefinition: ProviderMeteringPolicyDefinition = {
      ...platformCustomerDefinition,
      providerId,
      productId,
      resolvedModel: providerModel,
      supplierCostVersion: platformSupplierCost.id,
    };
    const platformCustomerPolicyId = `gateway-e2e-platform-customer-policy-${ids.label}`;
    const platformProviderPolicyId = `gateway-e2e-platform-provider-policy-${ids.label}`;
    await commercial.createCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformCustomerPolicyId,
      definition: platformCustomerDefinition,
      audit,
    });
    await commercial.createProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformProviderPolicyId,
      definition: platformProviderDefinition,
      audit,
    });
    const platformCustomerPolicy = await commercial.publishCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformCustomerPolicyId,
      expectedVersion: 1,
      definition: platformCustomerDefinition,
      audit,
    });
    const platformProviderPolicy = await commercial.publishProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformProviderPolicyId,
      expectedVersion: 1,
      definition: platformProviderDefinition,
      audit,
    });
    const platformContractDigest = '1'.repeat(64);
    const platformAttestationPayload = canonicalContractAttestationPayload({
      contractDigest: platformContractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      publicModelId,
      publicModelVersion: '1',
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      usageDimensions: platformCustomerDefinition.usageDimensions,
      tokenSource: platformCustomerDefinition.tokenSource,
      roundingVersion: platformCustomerDefinition.roundingVersion,
      roundingMode: platformCustomerDefinition.roundingMode,
      roundingBoundary: 'total',
    });
    const platformAttestationId = `gateway-e2e-platform-attestation-${ids.label}`;
    await commercial.attestProviderContract({
      tenantId: tenant.id,
      projectId: project.id,
      id: platformAttestationId,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      contractDigest: platformContractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      verifierKeyId: contractKeyId,
      signatureBase64: sign(null, Buffer.from(platformAttestationPayload), contractKeyPair.privateKey).toString(
        'base64',
      ),
      usageDimensions: platformCustomerDefinition.usageDimensions,
      tokenSource: platformCustomerDefinition.tokenSource,
      roundingVersion: platformCustomerDefinition.roundingVersion,
      roundingMode: platformCustomerDefinition.roundingMode,
      roundingBoundary: 'total',
      audit,
    });

    const platformRouteDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai' as const,
      supplyMode: 'platform' as const,
      targetMode: 'platform_pool' as const,
      upstreamId: platformPoolId,
      endpoint: ENDPOINT,
    };
    await routes.create({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      definition: platformRouteDefinition,
      audit,
    });
    const activePlatformRoute = await routes.publish({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      expectedVersion: 1,
      definition: platformRouteDefinition,
      audit,
    });
    assert.equal(activePlatformRoute.upstreamId, platformPoolId);
    await commercial.bindRoute({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      routeVersion: activePlatformRoute.version,
      customerPolicyId: platformCustomerPolicyId,
      customerPolicyVersion: platformCustomerPolicy.version,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      contractAttestationId: platformAttestationId,
      audit,
    });

    const owner: ProviderSupplyOwner = { ownerKind: 'tenant', tenantId: tenant.id, supplyMode: 'byok' };
    const supplyRepository = new PostgresProviderSupplyRepository(seedDatabase);
    const account = await supplyRepository.createAccount({
      owner,
      id: accountId,
      displayName: 'Gateway E2E BYOK Account',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: rights.rightsId,
      rightsVersion: rights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      status: 'active',
      validationState: 'verified',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await supplyRepository.createTenantByokProfileAccount({
      tenantId: tenant.id,
      supplyProfileId: profileId,
      accountId,
      effectiveAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: null,
      evidenceReference: `gateway-e2e-profile-account-${ids.label}`,
      evidenceSha256: 'f'.repeat(64),
    });

    await supplyRepository.createCredential({
      owner,
      id: credentialId,
      accountId,
      providerId,
      productId,
      credentialType: 'api-key',
      status: 'pending',
      validationState: 'unverified',
      expiresAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const credentialContext = createProviderCredentialContext({
      deployment: deploymentId,
      environment: environmentId,
      ownerKind: 'tenant',
      tenantId: tenant.id,
      supplyMode: 'byok',
      purpose: 'inference',
      providerId,
      productId,
      accountId,
      credentialId,
      credentialVersion: 1,
      credentialType: 'api-key',
    });
    const envelope = await sealProviderCredential(
      Buffer.from(PROVIDER_SECRET, 'utf8'),
      credentialContext,
      {
        generateDataKey: async () => ({
          plaintextKey: Uint8Array.from(DEK),
          ciphertextBlob: Buffer.from('gateway-e2e-wrapped-dek', 'utf8'),
        }),
      },
      'gateway-e2e-kms-key',
    );
    const appendedCredential = await supplyRepository.appendCredentialVersion({
      credential: { ownerKind: 'tenant', tenantId: tenant.id, accountId, credentialId, version: 1 },
      providerId,
      productId,
      envelope,
      kmsPurpose: 'inference',
      wrappingRevision: 1,
      expectedCurrentVersion: null,
      createdAt: nowIso,
      expiresAt: null,
    });
    const verifiedCredential = await seedDatabase.query<{ status: string; validation_state: string }>(
      `UPDATE saas_tenant_provider_credentials
          SET validation_state = 'verified',
              validation_error_code = NULL,
              last_validated_at = $1,
              status = 'active',
              updated_at = $1,
              authz_version = authz_version + 1
        WHERE tenant_id = $2 AND account_id = $3 AND id = $4 AND authz_version = $5
        RETURNING status, validation_state`,
      [nowIso, tenant.id, accountId, credentialId, appendedCredential.credential.authzVersion],
    );
    assert.deepEqual(verifiedCredential.rows, [{ status: 'active', validation_state: 'verified' }]);
    assert.equal(account.status, 'active');

    const platformSupply = new ProviderSupplyService(seedDatabase, {
      deployment: deploymentId,
      environment: environmentId,
      kmsKeyId: 'gateway-e2e-kms-key',
      sealingKms: {
        generateDataKey: async () => ({
          plaintextKey: Uint8Array.from(DEK),
          ciphertextBlob: Buffer.from('gateway-e2e-platform-wrapped-dek', 'utf8'),
        }),
      },
    });
    const platformAccount = await platformSupply.createPlatformProviderAccount({
      id: platformAccountId,
      displayName: 'Gateway E2E platform account',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: platformRights.rightsId,
      rightsVersion: platformRights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      audit,
    });
    assert.equal(platformAccount.ownerKind, 'platform');
    assert.equal(platformAccount.supplyMode, 'platform');
    const activePlatformAccount = await platformSupply.setProviderAccountValidation({
      accountId: platformAccount.id,
      validationState: 'verified',
      expectedAuthzVersion: platformAccount.authzVersion,
    });
    assert.equal(activePlatformAccount.status, 'active');
    const platformCredential = await platformSupply.createPlatformProviderCredential({
      accountId: activePlatformAccount.id,
      id: platformCredentialId,
      secret: Buffer.from(PLATFORM_PROVIDER_SECRET, 'utf8'),
      audit,
    });
    assert.equal(platformCredential.credential.ownerKind, 'platform');
    const activePlatformCredential = await seedDatabase.query<{ status: string; validation_state: string }>(
      `UPDATE saas_platform_provider_credentials
          SET validation_state = 'verified',
              validation_error_code = NULL,
              last_validated_at = $1,
              status = 'active',
              updated_at = $1,
              authz_version = authz_version + 1
        WHERE id = $2 AND account_id = $3 AND authz_version = $4
        RETURNING status, validation_state`,
      [nowIso, platformCredential.credential.id, activePlatformAccount.id, platformCredential.credential.authzVersion],
    );
    assert.deepEqual(activePlatformCredential.rows, [{ status: 'active', validation_state: 'verified' }]);
    const platformPool = await platformSupply.createPlatformProviderPool({
      id: platformPoolId,
      displayName: 'Gateway E2E platform pool',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: platformRights.rightsId,
      rightsVersion: platformRights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      status: 'active',
      validationState: 'verified',
    });
    await platformSupply.addPlatformPoolMember({
      poolId: platformPool.id,
      accountId: activePlatformAccount.id,
      expectedAccountAuthzVersion: activePlatformAccount.authzVersion,
    });
    const platformGrant = await platformSupply.grantPlatformPoolToProfile({
      poolId: platformPool.id,
      tenantId: tenant.id,
      supplyProfileId: platformProfileId,
      evidenceReference: `gateway-e2e-platform-grant-${ids.label}`,
      evidenceSha256: '8'.repeat(64),
    });
    assert.equal(platformGrant.status, 'active');
    assert.equal(platformGrant.profileAuthzVersion, 1);
    assert.equal(platformGrant.poolAuthzVersion, platformPool.authzVersion);

    const keyService = new KeyService(seedDatabase, {
      resolver: new PostgresSupplyProfileResolver(seedDatabase),
    });
    const createdKey = await keyService.create(tenantContext, {
      name: 'Gateway E2E Proxy Key',
      modelScopes: [publicModel],
      supplyMode: 'byok',
    });
    const platformKey = await keyService.create(tenantContext, {
      name: 'Gateway E2E Platform Proxy Key',
      modelScopes: [publicModel],
      supplyMode: 'platform',
    });
    assert.notEqual(platformKey.id, createdKey.id);
    assert.equal(platformKey.supplyMode, 'platform');
    assert.equal(platformKey.entitlementId, platformEntitlementId);
    assert.equal(platformKey.supplyProfileId, platformProfileId);
    assert.deepEqual(platformKey.modelScopes, [publicModel]);
    assert.equal(platformKey.entitlementAuthzVersion, 1);
    assert.equal(platformKey.supplyProfileAuthzVersion, 1);
    assert.equal(platformKey.modelScopeVersion, 1);
    await seedDatabase.query(
      `UPDATE saas_tenants
            SET requests_per_minute = 120, tokens_per_minute = 20000, max_concurrent_requests = 4
          WHERE id = $1`,
      [tenant.id],
    );
    // Migration 038 deliberately leaves project and key limits unset. Append
    // a configured immutable project-policy version and configure both keys
    // explicitly so this integration fixture can pass capacity admission.
    const projectCapacityVersion = (BigInt(projectPolicy.version) + 1n).toString();
    await seedDatabase.transaction(async (executor) => {
      const appendedProjectPolicy = await executor.query<{ version: string | number }>(
        `INSERT INTO saas_project_inference_policy_versions
           (tenant_id, project_id, version, status, changed_by_user_id, created_at,
            requests_per_minute, tokens_per_minute, max_concurrent_requests)
         SELECT policy.tenant_id, policy.project_id, $3, policy.status, $4, clock_timestamp(), $5, $6, $7
           FROM saas_project_inference_policy_versions AS policy
          WHERE policy.tenant_id = $1 AND policy.project_id = $2 AND policy.version = $8
         RETURNING version`,
        [tenant.id, project.id, projectCapacityVersion, administrator.id, 100, 16000, 4, projectPolicy.version],
      );
      assert.equal(appendedProjectPolicy.rows.length, 1, 'the project capacity policy version must be appended');
      assert.equal(String(appendedProjectPolicy.rows[0]?.version), projectCapacityVersion);

      const updatedProjectHead = await executor.query<{ inference_policy_version: string | number }>(
        `UPDATE saas_projects
            SET inference_policy_version = $3, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND inference_policy_version = $4
          RETURNING inference_policy_version`,
        [tenant.id, project.id, projectCapacityVersion, projectPolicy.version],
      );
      assert.equal(updatedProjectHead.rows.length, 1, 'the configured project policy must become the active head');
      assert.equal(String(updatedProjectHead.rows[0]?.inference_policy_version), projectCapacityVersion);

      const configuredKeys = await executor.query<{ id: string }>(
        `UPDATE saas_api_keys
            SET requests_per_minute = 60,
                tokens_per_minute = 8000,
                max_concurrent_requests = 2,
                authz_version = authz_version + 1
          WHERE tenant_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
          RETURNING id`,
        [tenant.id, project.id, [createdKey.id, platformKey.id]],
      );
      assert.equal(configuredKeys.rows.length, 2, 'both BYOK and platform API keys need explicit capacity limits');
    });

    // Disjoint tenants/projects/accounts/keys: unknown holds never consume
    // a later scene's wallet, capacity or account health. No second bootstrap.
    async function provisionFinancialFaultScope<Kind extends
      'json_missing_usage' | 'before_headers_cancel' | 'sse_partial_cancel' | 'json_invalid_usage'
    >(mode: 'byok' | 'platform', kind: Kind) {
      assert.ok(seedDatabase);
      const database = seedDatabase;
      const label = `fin-http-${mode}-${kind.replace(/_/g, '-')}-${randomUUID().replace(/-/g, '')}`;
      // Explicit identity slugs have a 63-character limit; retain the full
      // authority label, but use the same unique UUID in a bounded slug.
      const slug = `fin-${mode}-${label.slice(-32)}`;
      const scopedTenant = await identity.createTenant(administrator.id, { name: label, slug });
      const scopedProject = await identity.createProject(administrator.id, scopedTenant.id, { name: label, slug });
      const context = await identity.resolveTenantContext({
        userId: administrator.id, tenantId: scopedTenant.id, projectId: scopedProject.id,
      });
      const policy = await new SaasProjectInferencePolicyService(database).enable({
        tenantId: scopedTenant.id, projectId: scopedProject.id, expectedVersion: 1, audit,
      });
      const scopedProfileId = `${label}-profile`;
      const scopedAccountId = `${label}-account`;
      const scopedCredentialId = `${label}-credential`;
      const scopedUpstreamId = `${label}-${mode === 'platform' ? 'pool' : 'upstream'}`;
      await database.query(
        `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, $3, 'active', $4, 1, $5, $5, $5)`,
        [scopedTenant.id, scopedProfileId, mode, [publicModel], nowIso],
      );
      let scopedEntitlementId: string;
      if (mode === 'byok') {
        const scopedPlanId = `${label}-plan`;
        const scopedPlanVersionId = randomUUID();
        await database.query(
          `INSERT INTO saas_service_plans (id, slug, display_name, status, created_at, updated_at)
           VALUES ($1, $1, $1, 'published', $2, $2)`, [scopedPlanId, nowIso],
        );
        await database.query(
          `INSERT INTO saas_service_plan_versions
             (id, plan_id, version, supply_mode, supply_profile_id, allowed_provider_ids, allowed_models,
              price_version, price_minor_units, currency, term_days, policy_version, status, created_at, published_at)
           VALUES ($1, $2, 1, 'byok', $3, $4, $5, $6, 100, 'USD', 30, $7, 'published', $8, $8)`,
          [scopedPlanVersionId, scopedPlanId, scopedProfileId, [providerId], [publicModel],
            `${label}-price`, `${label}-policy`, nowIso],
        );
        const scopedOrder = await plans.createOrder(context, {
          planVersionId: scopedPlanVersionId, clientRequestId: `${label}-order`,
        });
        const boundOrder = await database.query<{ id: string }>(
          `UPDATE saas_service_plan_orders SET provider_key = $3, merchant_id = $4, provider_order_id = $5
           WHERE tenant_id = $1 AND id = $2 AND state = 'pending' RETURNING id`,
          [scopedTenant.id, scopedOrder.id, 'gateway-e2e-settlement-provider', 'gateway-e2e-merchant', `${label}-checkout`],
        );
        assert.deepEqual(boundOrder.rows.map(({ id }) => id), [scopedOrder.id]);
        const fulfilledScope = await plans.fulfillVerified({
          kind: 'server_verified_service_plan_fulfillment', orderId: scopedOrder.id,
          tenantId: scopedTenant.id, projectId: scopedProject.id, settlementId: `${label}-payment`,
          providerKey: 'gateway-e2e-settlement-provider', merchantId: 'gateway-e2e-merchant',
          amountMinorUnits: '100', currency: 'USD', fulfillmentReference: `${label}-fulfillment`,
          fulfillmentEvidenceSha256: 'e'.repeat(64), verifiedAt: now,
        });
        scopedEntitlementId = fulfilledScope.entitlementId;
        const bound = await plans.resolveBoundForRequest(
          { tenantId: scopedTenant.id, projectId: scopedProject.id }, scopedEntitlementId,
        );
        assert.ok(bound);
        assert.deepEqual(bound.allowedProviderIds, [providerId]);
      } else {
        scopedEntitlementId = randomUUID();
        await database.query(
          `INSERT INTO saas_project_entitlements
             (id, tenant_id, project_id, supply_profile_id, supply_mode, status, model_scopes,
              authz_version, created_at, updated_at, last_audited_at, effective_at, expires_at, source_type)
           VALUES ($1, $2, $3, $4, 'platform', 'active', $5, 1, $6, $6, $6, $7, $8, 'admin_grant')`,
          [scopedEntitlementId, scopedTenant.id, scopedProject.id, scopedProfileId, [publicModel],
            nowIso, entitlementEffectiveAt, entitlementExpiresAt],
        );
      }

      const scopedCustomerDefinition = mode === 'platform' ? platformCustomerDefinition : customerDefinition;
      const scopedProviderDefinition = mode === 'platform' ? platformProviderDefinition : providerDefinition;
      const scopedCustomerPolicyId = `${label}-customer-policy`;
      const scopedProviderPolicyId = `${label}-provider-policy`;
      const policyScope = { tenantId: scopedTenant.id, projectId: scopedProject.id, audit };
      await commercial.createCustomerPolicy({
        ...policyScope, policyId: scopedCustomerPolicyId, definition: scopedCustomerDefinition,
      });
      await commercial.createProviderPolicy({
        ...policyScope, policyId: scopedProviderPolicyId, definition: scopedProviderDefinition,
      });
      const scopedCustomerPolicy = await commercial.publishCustomerPolicy({
        ...policyScope, policyId: scopedCustomerPolicyId, expectedVersion: 1, definition: scopedCustomerDefinition,
      });
      const scopedProviderPolicy = await commercial.publishProviderPolicy({
        ...policyScope, policyId: scopedProviderPolicyId, expectedVersion: 1, definition: scopedProviderDefinition,
      });
      const roundingBoundary = scopedCustomerDefinition.roundingBoundary;
      assert.ok(roundingBoundary === 'total', 'the fault contract must bind its explicit total rounding boundary');
      const contract: Parameters<typeof canonicalContractAttestationPayload>[0] = {
        contractDigest: mode === 'platform' ? platformContractDigest : contractDigest,
        suiteVersion: 'gateway-e2e-suite-v1', testVectorDigest,
        providerPolicyId: scopedProviderPolicyId, providerPolicyVersion: scopedProviderPolicy.version,
        publicModelId, publicModelVersion: '1', protocol: 'openai', endpoint: ENDPOINT,
        supplyMode: mode, targetMode: scopedCustomerDefinition.targetMode,
        usageDimensions: scopedCustomerDefinition.usageDimensions, tokenSource: scopedCustomerDefinition.tokenSource,
        roundingVersion: scopedCustomerDefinition.roundingVersion, roundingMode: scopedCustomerDefinition.roundingMode,
        roundingBoundary,
      };
      const scopedAttestationId = `${label}-attestation`;
      await commercial.attestProviderContract({
        ...policyScope, ...contract, publicModelVersion: 1, id: scopedAttestationId, verifierKeyId: contractKeyId,
        signatureBase64: sign(null, Buffer.from(canonicalContractAttestationPayload(contract)),
          contractKeyPair.privateKey).toString('base64'),
      });
      const scopedRouteId = `${label}-route`;
      const definition = {
        ...routeDefinition, supplyMode: mode, targetMode: scopedCustomerDefinition.targetMode, upstreamId: scopedUpstreamId,
      };
      await routes.create({ ...policyScope, routeId: scopedRouteId, definition });
      const publishedRoute = await routes.publish({ ...policyScope, routeId: scopedRouteId, expectedVersion: 1, definition });
      assert.equal(publishedRoute.upstreamId, scopedUpstreamId);
      await commercial.bindRoute({
        ...policyScope, routeId: scopedRouteId, routeVersion: publishedRoute.version,
        customerPolicyId: scopedCustomerPolicyId, customerPolicyVersion: scopedCustomerPolicy.version,
        providerPolicyId: scopedProviderPolicyId, providerPolicyVersion: scopedProviderPolicy.version,
        contractAttestationId: scopedAttestationId,
      });

      if (mode === 'byok') {
        const scopedOwner: ProviderSupplyOwner = { ownerKind: 'tenant', tenantId: scopedTenant.id, supplyMode: 'byok' };
        await supplyRepository.createAccount({
          owner: scopedOwner, id: scopedAccountId, displayName: label, providerId, productId,
          credentialType: 'api-key', region: 'e2e-region', purpose: 'inference',
          rightsId: rights.rightsId, rightsVersion: rights.version,
          capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
          status: 'active', validationState: 'verified', createdAt: nowIso, updatedAt: nowIso,
        });
        await supplyRepository.createTenantByokProfileAccount({
          tenantId: scopedTenant.id, supplyProfileId: scopedProfileId, accountId: scopedAccountId,
          effectiveAt: entitlementEffectiveAt, expiresAt: null,
          evidenceReference: `${label}-profile-account`, evidenceSha256: 'f'.repeat(64),
        });
        await supplyRepository.createCredential({
          owner: scopedOwner, id: scopedCredentialId, accountId: scopedAccountId, providerId, productId,
          credentialType: 'api-key', status: 'pending', validationState: 'unverified',
          expiresAt: null, createdAt: nowIso, updatedAt: nowIso,
        });
        const scopedEnvelope = await sealProviderCredential(
          Buffer.from(PROVIDER_SECRET, 'utf8'),
          createProviderCredentialContext({
            deployment: deploymentId, environment: environmentId, ownerKind: 'tenant', tenantId: scopedTenant.id,
            supplyMode: 'byok', purpose: 'inference', providerId, productId, accountId: scopedAccountId,
            credentialId: scopedCredentialId, credentialVersion: 1, credentialType: 'api-key',
          }),
          { generateDataKey: async () => ({
            plaintextKey: Uint8Array.from(DEK), ciphertextBlob: Buffer.from('gateway-e2e-wrapped-dek', 'utf8'),
          }) },
          'gateway-e2e-kms-key',
        );
        const appended = await supplyRepository.appendCredentialVersion({
          credential: { ownerKind: 'tenant', tenantId: scopedTenant.id, accountId: scopedAccountId,
            credentialId: scopedCredentialId, version: 1 },
          providerId, productId, envelope: scopedEnvelope, kmsPurpose: 'inference', wrappingRevision: 1,
          expectedCurrentVersion: null, createdAt: nowIso, expiresAt: null,
        });
        const verified = await database.query<{ status: string; validation_state: string }>(
          `UPDATE saas_tenant_provider_credentials
             SET validation_state = 'verified', validation_error_code = NULL, last_validated_at = $1,
                 status = 'active', updated_at = $1, authz_version = authz_version + 1
           WHERE tenant_id = $2 AND account_id = $3 AND id = $4 AND authz_version = $5
           RETURNING status, validation_state`,
          [nowIso, scopedTenant.id, scopedAccountId, scopedCredentialId, appended.credential.authzVersion],
        );
        assert.deepEqual(verified.rows, [{ status: 'active', validation_state: 'verified' }]);
      } else {
        const scopedAccount = await platformSupply.createPlatformProviderAccount({
          id: scopedAccountId, displayName: label, providerId, productId, credentialType: 'api-key',
          region: 'e2e-region', purpose: 'inference', rightsId: platformRights.rightsId, rightsVersion: platformRights.version,
          capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }], audit,
        });
        const activated = await platformSupply.setProviderAccountValidation({
          accountId: scopedAccount.id, validationState: 'verified', expectedAuthzVersion: scopedAccount.authzVersion,
        });
        assert.equal(activated.status, 'active');
        const sealed = await platformSupply.createPlatformProviderCredential({
          accountId: activated.id, id: scopedCredentialId, secret: Buffer.from(PLATFORM_PROVIDER_SECRET, 'utf8'), audit,
        });
        const verified = await database.query<{ status: string; validation_state: string }>(
          `UPDATE saas_platform_provider_credentials
             SET validation_state = 'verified', validation_error_code = NULL, last_validated_at = $1,
                 status = 'active', updated_at = $1, authz_version = authz_version + 1
           WHERE id = $2 AND account_id = $3 AND authz_version = $4 RETURNING status, validation_state`,
          [nowIso, scopedCredentialId, scopedAccountId, sealed.credential.authzVersion],
        );
        assert.deepEqual(verified.rows, [{ status: 'active', validation_state: 'verified' }]);
        const pool = await platformSupply.createPlatformProviderPool({
          id: scopedUpstreamId, displayName: label, providerId, productId, credentialType: 'api-key',
          region: 'e2e-region', purpose: 'inference', rightsId: platformRights.rightsId, rightsVersion: platformRights.version,
          capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
          status: 'active', validationState: 'verified',
        });
        await platformSupply.addPlatformPoolMember({
          poolId: pool.id, accountId: activated.id, expectedAccountAuthzVersion: activated.authzVersion,
        });
        const grant = await platformSupply.grantPlatformPoolToProfile({
          poolId: pool.id, tenantId: scopedTenant.id, supplyProfileId: scopedProfileId,
          evidenceReference: `${label}-grant`, evidenceSha256: '8'.repeat(64),
        });
        assert.equal(grant.status, 'active');
        await database.transaction((executor) => new PlatformWalletLedgerService().postVerifiedFunding(executor, {
          tenantId: scopedTenant.id, currency: 'USD', amountMinorUnits: '1000',
          sourceOrderRef: `${label}-funding`, idempotencyKey: `${label}-funding`, metadataRef: `${label}-funding`,
        }));
      }
      const scopedKey = await keyService.create(context, { name: label, modelScopes: [publicModel], supplyMode: mode });
      assert.equal(scopedKey.entitlementId, scopedEntitlementId);
      assert.equal(scopedKey.supplyProfileId, scopedProfileId);
      // Set previously absent limits once, to one concurrent request per
      // independent scope. Never increase capacity to admit a retained hold.
      await database.query(
        `UPDATE saas_tenants SET requests_per_minute = 60, tokens_per_minute = 8000, max_concurrent_requests = 1
         WHERE id = $1`, [scopedTenant.id],
      );
      const nextPolicyVersion = (BigInt(policy.version) + 1n).toString();
      await database.transaction(async (executor) => {
        const appended = await executor.query(
          `INSERT INTO saas_project_inference_policy_versions
             (tenant_id, project_id, version, status, changed_by_user_id, created_at,
              requests_per_minute, tokens_per_minute, max_concurrent_requests)
           SELECT tenant_id, project_id, $3, status, $4, clock_timestamp(), 60, 8000, 1
             FROM saas_project_inference_policy_versions
            WHERE tenant_id = $1 AND project_id = $2 AND version = $5 RETURNING version`,
          [scopedTenant.id, scopedProject.id, nextPolicyVersion, administrator.id, policy.version],
        );
        assert.equal(appended.rowCount, 1);
        const head = await executor.query(
          `UPDATE saas_projects SET inference_policy_version = $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND inference_policy_version = $4 RETURNING inference_policy_version`,
          [scopedTenant.id, scopedProject.id, nextPolicyVersion, policy.version],
        );
        assert.equal(head.rowCount, 1);
        const key = await executor.query(
          `UPDATE saas_api_keys SET requests_per_minute = 60, tokens_per_minute = 8000,
                 max_concurrent_requests = 1, authz_version = authz_version + 1
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING id`,
          [scopedTenant.id, scopedProject.id, scopedKey.id],
        );
        assert.equal(key.rowCount, 1);
      });
      return {
        mode, kind, context, accountId: scopedAccountId, upstreamId: scopedUpstreamId,
        key: scopedKey, entitlementId: scopedEntitlementId, profileId: scopedProfileId,
      };
    }
    const financialFaultScopes: Array<Awaited<ReturnType<typeof provisionFinancialFaultScope>> & {
      readonly kind: 'json_missing_usage' | 'before_headers_cancel';
    }> = [];
    for (const mode of ['byok', 'platform'] as const) {
      for (const kind of ['json_missing_usage', 'before_headers_cancel'] as const) {
        financialFaultScopes.push(await provisionFinancialFaultScope(mode, kind));
      }
    }
    assert.equal(financialFaultScopes.length, 4, 'all four independent fault scopes are required');
    for (const values of [
      financialFaultScopes.map((scope) => scope.context.tenantId),
      financialFaultScopes.map((scope) => scope.context.projectId),
      financialFaultScopes.map((scope) => scope.accountId),
      financialFaultScopes.map((scope) => scope.key.id),
      financialFaultScopes.map((scope) => scope.upstreamId),
    ]) assert.equal(new Set(values).size, 4, 'fault scopes must not share authority or resource identities');

    const sseFinancialFaultScopes: Array<Awaited<ReturnType<typeof provisionFinancialFaultScope>>> = [];
    for (const mode of ['byok', 'platform'] as const) {
      sseFinancialFaultScopes.push(await provisionFinancialFaultScope(mode, 'sse_partial_cancel'));
    }
    assert.equal(sseFinancialFaultScopes.length, 2, 'both independent SSE fault scopes are required');
    const allFinancialFaultScopes = [...financialFaultScopes, ...sseFinancialFaultScopes];
    assert.ok(allFinancialFaultScopes.every((scope) => scope.context.tenantId !== tenant.id));
    for (const values of [
      allFinancialFaultScopes.map((scope) => scope.context.tenantId),
      allFinancialFaultScopes.map((scope) => scope.context.projectId),
      allFinancialFaultScopes.map((scope) => scope.accountId),
      allFinancialFaultScopes.map((scope) => scope.key.id),
      allFinancialFaultScopes.map((scope) => scope.upstreamId),
    ]) assert.equal(new Set(values).size, 6, 'all uncertainty scenes need independent tenant-level resources');

    // Each invalid counter variant gets its own tenant/resources in BOTH
    // modes; retained unknown capacity or funds must not block a later case.
    const invalidJsonUsageCases = [
      { variant: 'negative', usage: { prompt_tokens: 3, completion_tokens: -1, total_tokens: 5 } },
      { variant: 'fractional', usage: { prompt_tokens: 3, completion_tokens: 1.5, total_tokens: 5 } },
      { variant: 'unsafe_integer', usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2, total_tokens: 5 } },
      { variant: 'inconsistent_total', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 6 } },
      { variant: 'cache_overflow', usage: {
        prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 4 },
      } },
      { variant: 'reasoning_overflow', usage: {
        prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 },
      } },
      { variant: 'unknown_dimension', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, audio_tokens: 1 } },
      // Both repeated values are valid individually: rejecting this case
      // requires ambiguity rejection, not JSON.parse's last-value behavior.
      { variant: 'duplicate_usage', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ] as const satisfies readonly { readonly variant: InvalidJsonUsageVariant; readonly usage: Readonly<Record<string, unknown>> }[];
    assert.equal(invalidJsonUsageCases.length, 8);
    assert.deepEqual(invalidJsonUsageCases.map((entry) => entry.variant), [...INVALID_JSON_USAGE_VARIANTS]);
    const invalidJsonUsageScopes: Array<Awaited<ReturnType<typeof provisionFinancialFaultScope>> & {
      readonly usageCase: (typeof invalidJsonUsageCases)[number];
    }> = [];
    for (const mode of ['byok', 'platform'] as const) {
      for (const usageCase of invalidJsonUsageCases) {
        invalidJsonUsageScopes.push({
          ...await provisionFinancialFaultScope(mode, 'json_invalid_usage'), usageCase,
        });
      }
    }
    assert.equal(invalidJsonUsageScopes.length, 16, 'all eight invalid variants in both modes need independent scopes');
    for (const mode of ['byok', 'platform'] as const) {
      assert.deepEqual(invalidJsonUsageScopes.filter((scope) => scope.mode === mode).map((scope) => scope.usageCase.variant),
        [...INVALID_JSON_USAGE_VARIANTS]);
    }
    const registeredFinancialFaultScopes = [...allFinancialFaultScopes, ...invalidJsonUsageScopes];
    assert.ok(registeredFinancialFaultScopes.every((scope) => scope.context.tenantId !== tenant.id));
    for (const values of [
      registeredFinancialFaultScopes.map((scope) => scope.context.tenantId),
      registeredFinancialFaultScopes.map((scope) => scope.context.projectId),
      registeredFinancialFaultScopes.map((scope) => scope.accountId),
      registeredFinancialFaultScopes.map((scope) => scope.key.id),
      registeredFinancialFaultScopes.map((scope) => scope.upstreamId),
    ]) assert.equal(new Set(values).size, 22, 'no invalid-usage scene may reuse any prior uncertainty scope');

    const probeAttemptId = randomUUID();
    const leaseService = new PostgresProviderAccountLeaseService({
      database: seedDatabase,
      maxConcurrency: 2,
      leaseTtlMs: 30_000,
    });
    const probeEvidence = {
      tenantId: tenant.id,
      projectId: project.id,
      requestId: randomUUID(),
      attemptId: probeAttemptId,
      evidenceId: randomUUID(),
      accountId,
      upstreamId,
      supplyMode: 'byok',
    } as PreparedRequestEvidenceRecord;
    const probeLease = await leaseService.acquire({
      tenantId: tenant.id,
      accountId,
      upstreamId,
      attemptId: probeAttemptId,
      evidence: probeEvidence,
    });
    assert.ok(probeLease, 'the PostgreSQL provider lease must be acquired');
    const health = new PostgresProviderAccountRuntimeHealthStore({ database: seedDatabase });
    assert.equal(
      await health.recordRuntimeOutcome({
        candidate: {
          tenantId: tenant.id,
          accountId,
          upstreamId,
          supplyMode: 'byok',
          accountOwnerKind: 'tenant',
        },
        attemptId: probeAttemptId,
        fencingToken: probeLease.fencingToken,
        evidence: { source: 'probe', result: 'success' },
      }),
      'applied',
    );
    await probeLease.release();

    const platformProbeAttemptId = randomUUID();
    const platformProbeEvidence = {
      tenantId: tenant.id,
      projectId: project.id,
      requestId: randomUUID(),
      attemptId: platformProbeAttemptId,
      evidenceId: randomUUID(),
      accountId: activePlatformAccount.id,
      upstreamId: platformPoolId,
      supplyMode: 'platform',
      accountOwnerKind: 'platform',
    } as PreparedRequestEvidenceRecord;
    const platformProbeLease = await leaseService.acquire({
      tenantId: tenant.id,
      accountId: activePlatformAccount.id,
      upstreamId: platformPoolId,
      attemptId: platformProbeAttemptId,
      evidence: platformProbeEvidence,
    });
    assert.ok(platformProbeLease, 'the PostgreSQL platform provider lease must be acquired');
    try {
      assert.equal(
        await health.recordRuntimeOutcome({
          candidate: {
            tenantId: tenant.id,
            accountId: activePlatformAccount.id,
            upstreamId: platformPoolId,
            supplyMode: 'platform',
            accountOwnerKind: 'platform',
          },
          attemptId: platformProbeAttemptId,
          fencingToken: platformProbeLease.fencingToken,
          evidence: { source: 'probe', result: 'success' },
        }),
        'applied',
      );
    } finally {
      await platformProbeLease.release();
    }

    const usedPorts = new Set<number>([upstreamPort]);
    const customerPort = await freeLocalPort(usedPorts);
    const platformPort = await freeLocalPort(usedPorts);
    const controlPlaneEnvironment = {
      NODE_ENV: 'test',
      [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
      [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: roleUrls.controlPlane,
      [MODEL_ROUTER_SAAS_REDIS_URL]: 'redis://127.0.0.1:6379',
      [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: '@model-router/e2e-redis-provider',
      [MODEL_ROUTER_SAAS_KMS_PROVIDER]: '@model-router/e2e-credential-provider',
      [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: deploymentId,
      [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: environmentId,
      [SAAS_PLATFORM_AUDIT_CURSOR_SECRET]: 'gateway-e2e-cursor-secret-0123456789',
      ...listenerEnvironment('customer', customerPort),
      ...listenerEnvironment('platform', platformPort),
    };
    const controlPlaneDeployment = parseDeploymentConfig(controlPlaneEnvironment);
    assert.equal(controlPlaneDeployment.mode, 'managed-saas');
    if (controlPlaneDeployment.mode !== 'managed-saas') throw new Error('control-plane deployment did not parse');
    const providers = {
      credentialKeyProvider: {
        getCurrentKey: async () => ({ keyId: 'gateway-e2e-platform-key', key: new Uint8Array(32).fill(7) }),
        getKey: async () => new Uint8Array(32).fill(7),
        checkReady: async () => {},
        close: async () => {},
      },
      platformAuthRateLimiter: { take: async () => undefined },
      customerAuthRateLimiter: { take: async () => undefined },
      close: async () => {},
    };
    controlPlaneRuntime = await startManagedSaasServer(controlPlaneDeployment, {
      environment: controlPlaneEnvironment,
      loadProviders: async () => providers,
      installSignalHandlers: false,
    });
    const controlPlaneUser = await controlPlaneRuntime.database.query<{ current_user: string }>('SELECT current_user');
    assert.equal(controlPlaneUser.rows[0]?.current_user, 'model_router_saas_control_plane');
    assert.deepEqual(Object.keys(controlPlaneRuntime.listeners).sort(), ['customer', 'platform']);

    const evidenceKeyPair = generateKeyPairSync('ed25519');
    const evidenceKeyId = `gateway-e2e-evidence-${ids.label}`;
    const testAddressCapability = createProviderHttpTestAddressCapability(certificatePem);
    const endpointPolicy = { allowedHosts: ['127.0.0.1'], allowedPorts: [upstreamPort] } as const;
    const providerTargetResolver = createProviderTargetResolver({
      bindings: [
        {
          upstreamId,
          productId,
          protocol: 'openai',
          operation: 'chat.completions',
          baseUrl: `https://127.0.0.1:${upstreamPort}`,
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [upstreamPort],
          path: ENDPOINT,
          method: 'POST',
        },
        {
          upstreamId: platformPoolId,
          productId,
          protocol: 'openai',
          operation: 'chat.completions',
          baseUrl: `https://127.0.0.1:${upstreamPort}`,
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [upstreamPort],
          path: ENDPOINT,
          method: 'POST',
        },
        ...registeredFinancialFaultScopes.map((scope) => ({
          upstreamId: scope.upstreamId, productId, protocol: 'openai' as const,
          operation: 'chat.completions', baseUrl: `https://127.0.0.1:${upstreamPort}`,
          allowedHosts: ['127.0.0.1'], allowedPorts: [upstreamPort], path: ENDPOINT, method: 'POST' as const,
        })),
      ],
      testAddressCapability,
    });
    const fixtureUpstreamIds = new Set([
      upstreamId, platformPoolId, ...registeredFinancialFaultScopes.map((scope) => scope.upstreamId),
    ]);
    const gatewayPort = await freeLocalPort(usedPorts);
    const gatewayEnvironment = {
      NODE_ENV: 'test',
      [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'gateway',
      [MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL]: roleUrls.gateway,
      [MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]: '@model-router/e2e-gateway-runtime',
      [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@model-router/e2e-gateway-kms',
      [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: deploymentId,
      [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: environmentId,
      ...listenerEnvironment('gateway', gatewayPort),
    };
    const gatewayDeployment = parseDeploymentConfig(gatewayEnvironment);
    assert.equal(gatewayDeployment.mode, 'managed-saas');
    if (gatewayDeployment.mode !== 'managed-saas') throw new Error('gateway deployment did not parse');

    const createRuntimeDependencies = (
      database: ManagedSaasGatewayRuntimeModuleOptions['database'],
    ): ManagedSaasGatewayRuntimeDependencies => {
      const serverSupplyProfileResolver = new PostgresSupplyProfileResolver(database);
      const registry = new TrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: evidenceKeyId, publicKey: evidenceKeyPair.publicKey, status: 'active' }],
      });
      const evidenceSigner = new PreparedRequestEvidenceSigner({
        registry,
        verifierKeyId: evidenceKeyId,
        privateKey: evidenceKeyPair.privateKey,
      });
      const entitlementResolver: RequestPreparationEntitlementPort = {
        async resolve({ caller, publicModel: requestedModel, protocol }) {
          // Only explicitly provisioned, server-resolved fixture principals.
          const callerContext = [tenantContext, ...registeredFinancialFaultScopes.map((scope) => scope.context)].find(
            (context) => caller.tenantId === context.tenantId && caller.projectId === context.projectId &&
              caller.principalKind === 'member' && caller.principalId === context.userId,
          );
          if (requestedModel !== publicModel || protocol !== 'openai' || !callerContext) {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          const projects = await database.query<{
            readonly inference_policy_status: string;
            readonly inference_policy_version: number | string;
          }>(
            `SELECT inference_policy_status, inference_policy_version
                 FROM saas_projects
                WHERE tenant_id = $1 AND id = $2
                LIMIT 2`,
            [caller.tenantId, caller.projectId],
          );
          const projectRow = projects.rows[0];
          if (projects.rows.length !== 1 || projectRow?.inference_policy_status !== 'active') {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          if (caller.supplyMode === 'platform') {
            const resolvedPlatformEntitlement = await serverSupplyProfileResolver
              .resolve(callerContext, 'platform', {
                entitlementId: caller.entitlementId,
              })
              .catch((error: unknown) => {
                // Preserve the original fail-closed null result. Only an own
                // data code is inspected; never message/cause/body/authority.
                try {
                  const ownCode: unknown = error !== null && typeof error === 'object'
                    ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
                  const code = error instanceof SaasKeyError &&
                    (ownCode === 'KEY_SUPPLY_UNAVAILABLE' || ownCode === 'KEY_PROFILE_INVALID')
                    ? ownCode : 'unrecognized_code';
                  t.diagnostic(`gateway_preparation ${JSON.stringify({
                    outcome: 'resolver_exception',
                    stage: 'entitlement',
                    reason: 'platform_entitlement_resolver_exception',
                    code,
                    sqlState: typeof ownCode === 'string' && SAFE_PREPARATION_SQL_STATES.has(ownCode)
                      ? ownCode : 'unrecognized_sqlstate',
                  })}`);
                } catch { /* Diagnostic projection cannot change the swallowed result. */ }
                return null;
              });
            if (
              resolvedPlatformEntitlement?.mode !== 'platform' ||
              resolvedPlatformEntitlement.entitlementId !== caller.entitlementId ||
              resolvedPlatformEntitlement.profileId !== caller.supplyProfileId ||
              resolvedPlatformEntitlement.entitlementAuthzVersion !== Number(caller.entitlementVersion) ||
              resolvedPlatformEntitlement.supplyProfileAuthzVersion !== Number(caller.supplyProfileVersion) ||
              resolvedPlatformEntitlement.modelScopeVersion !== Number(caller.modelScopeVersion) ||
              !resolvedPlatformEntitlement.allowedModels.includes(requestedModel)
            ) {
              return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
            }
            return allowRequestPreparation({
              tenantId: caller.tenantId,
              projectId: caller.projectId,
              proxyKeyId: caller.proxyKeyId,
              entitlementId: resolvedPlatformEntitlement.entitlementId,
              entitlementVersion: resolvedPlatformEntitlement.entitlementAuthzVersion,
              supplyProfileId: resolvedPlatformEntitlement.profileId,
              supplyProfileVersion: resolvedPlatformEntitlement.supplyProfileAuthzVersion,
              supplyMode: resolvedPlatformEntitlement.mode,
              modelScopeVersion: resolvedPlatformEntitlement.modelScopeVersion,
              allowedModels: [...resolvedPlatformEntitlement.allowedModels],
              allowedProviderIds: [],
              projectPolicyVersion: String(projectRow.inference_policy_version),
            });
          }
          if (caller.supplyMode !== 'byok') {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          return allowRequestPreparation({
            tenantId: caller.tenantId,
            projectId: caller.projectId,
            proxyKeyId: caller.proxyKeyId,
            entitlementId: caller.entitlementId,
            entitlementVersion: caller.entitlementVersion,
            supplyProfileId: caller.supplyProfileId,
            supplyProfileVersion: caller.supplyProfileVersion,
            supplyMode: caller.supplyMode,
            modelScopeVersion: caller.modelScopeVersion,
            allowedModels: [...caller.modelScopes],
            allowedProviderIds: [providerId],
            projectPolicyVersion: String(projectRow.inference_policy_version),
          });
        },
      };

      return {
        entitlementResolver,
        schedulerAuthorities: {
          affinityKeyring: {
            activeKeyVersion: 'gateway-e2e-affinity-v1',
            keys: [{ version: 'gateway-e2e-affinity-v1', key: new Uint8Array(32).fill(0x42) }],
          },
          leaseConcurrencyLimit: 2,
        },
        idempotencyHmacKey: new Uint8Array(32).fill(0x53),
        providerPreparationRoute: async ({ authority }) => ({
          clientProtocol: 'openai',
          providerProtocol: 'openai',
          clientOperation: 'chat.completions',
          providerOperation: 'chat.completions',
          modelResolution: authority.modelResolution ?? {
            requestedModel: publicModel,
            mappedModel: publicModel,
            resolvedModel: providerModel,
            mappingSource: 'alias',
            mappingVersion: 1,
          },
        }),
        providerPayload: {
          estimator: {
            version: 'gateway-e2e-estimator-v1',
            estimate: async () => usageBounds,
          },
          modelCompatibility: async (input) =>
            input.providerId === providerId &&
            input.productId === productId &&
            input.providerModel === providerModel &&
            input.providerProtocol === 'openai' &&
            input.providerOperation === 'chat.completions',
          maxPayloadBytes: 1024 * 1024,
          compilerVersion: 'gateway-e2e-payload-v1',
        },
        evidenceSigner,
        evidenceVerifierKeyId: evidenceKeyId,
        idFactory: {
          requestId: randomUUID,
          attemptId: randomUUID,
          evidenceId: randomUUID,
        },
        trustedVerifierPublicKeys: new Map([[evidenceKeyId, evidenceKeyPair.publicKey]]),
        providerTargetResolver,
        providerTargetRoute: async (input) =>
          fixtureUpstreamIds.has(input.upstreamId)
            ? { productId, providerProtocol: 'openai', providerOperation: 'chat.completions' }
            : null,
        resolveAuthenticationHeader: async () => 'authorization',
        fetch: undiciFetch as unknown as ManagedSaasGatewayRuntimeDependencies['fetch'],
        endpointPolicy,
        timeoutMs: 10_000,
        maxConcurrency: 2,
        leaseTtlMs: 30_000,
        maxBodyBytes: 1024 * 1024,
        entryPoint: 'managed-saas-gateway-real-postgres-e2e',
        providerHttpTestAddressCapability: testAddressCapability,
      };
    };

    gatewayRuntime = await startManagedSaasServer(gatewayDeployment, {
      environment: gatewayEnvironment,
      installSignalHandlers: false,
      gatewayRuntimeModuleImporter: async () => ({
        createManagedSaasGatewayRuntime: async (options: ManagedSaasGatewayRuntimeModuleOptions) => ({
          dependencies: createRuntimeDependencies(options.database),
          checkReady: async () => {},
          close: async () => {},
        }),
      }),
      gatewayProviderCredentialKmsImporter: async () => ({
        createGatewayProviderCredentialUnsealingKms: () => ({
          decryptDataKey: async () => Uint8Array.from(DEK),
          checkReady: async () => {},
          close: async () => {},
        }),
      }),
    });
    const gatewayUser = await gatewayRuntime.database.query<{ current_user: string }>('SELECT current_user');
    assert.equal(gatewayUser.rows[0]?.current_user, 'model_router_saas_gateway');
    assert.deepEqual(Object.keys(gatewayRuntime.listeners), ['gateway']);
    const preparationDiagnostic = observePreparationFailures(gatewayRuntime, (diagnostic) => {
      t.diagnostic(`gateway_preparation ${JSON.stringify(diagnostic)}`);
    });
    const dispatchDiagnostic = observeDispatchFailures(gatewayRuntime, dispatchCompletions, (diagnostic) => {
      t.diagnostic(`gateway_dispatch ${JSON.stringify({
        ...diagnostic,
        boundary: dispatchCompletions.closeStarted ? 'after_close_started' : 'before_close_started',
      })}`);
    });
    const reportHttpResponseDiagnostic = (
      supplyMode: 'byok' | 'platform', status: number, body: string, callsBefore: number,
    ): string => {
      const upstreamReceived = upstreamCallCount > callsBefore;
      // Only match the fixed local fixture error; arbitrary response bodies,
      // messages, credentials and request identities never enter this report.
      const diagnostic = `gateway_http_response ${JSON.stringify({
        supplyMode,
        status,
        upstreamCallCount,
        upstreamReceived,
        upstreamMatches: upstreamReceived ? upstreamMatches : null,
        fixedFixtureErrorShapeMatches: /^\s*\{\s*"error"\s*:\s*"unexpected local test request"\s*\}\s*$/.test(body),
        preparation: preparationDiagnostic(),
        dispatch: dispatchDiagnostic(),
      })}`;
      t.diagnostic(diagnostic);
      return diagnostic;
    };

    const walletBefore = await walletSnapshot(seedDatabase, tenant.id);
    const publicCallsBefore = upstreamCallCount;
    const publicDispatchCheckpoint = dispatchCompletions.checkpoint();
    const publicResponse = await fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createdKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': `gateway-e2e-request-${ids.label}`,
      },
      body: JSON.stringify({
        model: publicModel,
        messages: [{ role: 'user', content: 'real PostgreSQL gateway integration' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const publicBody = await publicResponse.text();
    const publicResponseDiagnostic = reportHttpResponseDiagnostic('byok', publicResponse.status, publicBody, publicCallsBefore);
    assert.equal(publicResponse.status, 200, publicResponseDiagnostic);
    assert.match(publicResponse.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.match(publicBody, /e2e-ok/);
    assert.match(publicBody, /\[DONE\]/);
    assert.equal(upstreamCallCount, 1);
    assert.equal(upstreamAuthorization, `Bearer ${PROVIDER_SECRET}`);
    await dispatchCompletions.waitForCompletion(publicResponse.headers.get('x-request-id'), publicDispatchCheckpoint);

    const durable = await seedDatabase.query<{
      request_id: string;
      execution_state: string;
      financial_status: string;
      supply_mode: string;
      dispatch_state: string;
      result_state: string;
      response_started: boolean;
      result_http_status: number | null;
      usage_status: string | null;
      usage_source: string | null;
      input_total: string | null;
      output_total: string | null;
      usage_settlement_count: string;
    }>(
      `SELECT r.id AS request_id, r.execution_state, r.financial_status, r.supply_mode,
                a.dispatch_state, a.result_state, a.response_started, a.result_http_status,
                u.status AS usage_status, u.source AS usage_source,
                u.input_total::text AS input_total, u.output_total::text AS output_total,
                (SELECT count(*)::text FROM saas_usage_settlements s
                  WHERE s.tenant_id = r.tenant_id AND s.request_id = r.id AND s.attempt_id = a.id
                    AND s.kind = 'usage_recorded') AS usage_settlement_count
           FROM saas_requests r
           JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
           LEFT JOIN saas_usage_events u ON u.tenant_id = r.tenant_id AND u.request_id = r.id AND u.attempt_id = a.id
          WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.proxy_key_id = $3
          ORDER BY r.created_at DESC, a.ordinal DESC
          LIMIT 1`,
      [tenant.id, project.id, createdKey.id],
    );
    assert.equal(durable.rows.length, 1);
    const record = durable.rows[0];
    assert.ok(record);
    assert.equal(record.execution_state, 'succeeded');
    assert.equal(record.financial_status, 'not_applicable');
    assert.equal(record.supply_mode, 'byok');
    assert.equal(record.dispatch_state, 'sent');
    assert.equal(record.result_state, 'succeeded');
    assert.equal(record.response_started, true);
    assert.equal(record.result_http_status, 200);
    assert.equal(record.usage_status, 'reported');
    assert.equal(record.usage_source, 'upstream');
    assert.equal(record.input_total, '3');
    assert.equal(record.output_total, '2');
    assert.equal(record.usage_settlement_count, '1');

    const walletAfter = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(walletAfter, walletBefore, 'a BYOK gateway request must not mutate the platform wallet ledger');

    await seedDatabase.transaction((executor) =>
      new PlatformWalletLedgerService().postVerifiedFunding(executor, {
        tenantId: tenant.id,
        currency: 'USD',
        amountMinorUnits: '1000',
        sourceOrderRef: `gateway-e2e-platform-funding-${ids.label}`,
        idempotencyKey: `gateway-e2e-platform-funding-${ids.label}`,
        metadataRef: `gateway-e2e-platform-funding-${ids.label}`,
      }),
    );
    const platformWalletBefore = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(platformWalletBefore, {
      wallets: '1',
      wallet_balance: '1000',
      billing_reservations: '0',
      ledger_transactions: '1',
      ledger_entries: '2',
    });

    const platformCallsBefore = upstreamCallCount;
    const platformDispatchCheckpoint = dispatchCompletions.checkpoint();
    const platformResponse = await fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${platformKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': `gateway-e2e-platform-request-${ids.label}`,
      },
      body: JSON.stringify({
        model: publicModel,
        messages: [{ role: 'user', content: 'real PostgreSQL platform gateway integration' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const platformBody = await platformResponse.text();
    const platformResponseDiagnostic = reportHttpResponseDiagnostic('platform', platformResponse.status, platformBody, platformCallsBefore);
    assert.equal(platformResponse.status, 200, platformResponseDiagnostic);
    assert.match(platformResponse.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.match(platformBody, /e2e-ok/);
    assert.match(platformBody, /\[DONE\]/);
    assert.equal(upstreamCallCount, 2);
    assert.deepEqual(upstreamAuthorizations, [`Bearer ${PROVIDER_SECRET}`, `Bearer ${PLATFORM_PROVIDER_SECRET}`]);
    assert.equal(upstreamAuthorization, `Bearer ${PLATFORM_PROVIDER_SECRET}`);
    await dispatchCompletions.waitForCompletion(platformResponse.headers.get('x-request-id'), platformDispatchCheckpoint);

    const platformDurable = await seedDatabase.query<{
      request_id: string;
      entitlement_id: string;
      supply_profile_id: string;
      execution_state: string;
      financial_status: string;
      supply_mode: string;
      request_customer_price_version: string | null;
      binding_state: string;
      dispatch_authority_state: string;
      account_owner_kind: string | null;
      tenant_account_id: string | null;
      platform_account_id: string | null;
      pool_id: string | null;
      attempt_customer_price_version: string | null;
      supplier_cost_version: string | null;
      dispatch_state: string;
      result_state: string;
      response_started: boolean;
      result_http_status: number | null;
      usage_status: string | null;
      usage_source: string | null;
      usage_supply_mode: string | null;
      input_total: string | null;
      output_total: string | null;
      usage_settlement_count: string;
    }>(
      `SELECT r.id AS request_id, r.entitlement_id, r.supply_profile_id,
                r.execution_state, r.financial_status, r.supply_mode,
                r.customer_price_version AS request_customer_price_version,
                a.binding_state, a.dispatch_authority_state, a.account_owner_kind,
                a.tenant_account_id, a.platform_account_id, a.pool_id,
                a.customer_price_version AS attempt_customer_price_version,
                a.supplier_cost_version, a.dispatch_state, a.result_state,
                a.response_started, a.result_http_status,
                u.status AS usage_status, u.source AS usage_source, u.supply_mode AS usage_supply_mode,
                u.input_total::text AS input_total, u.output_total::text AS output_total,
                (SELECT count(*)::text FROM saas_usage_settlements s
                  WHERE s.tenant_id = r.tenant_id AND s.request_id = r.id AND s.attempt_id = a.id
                    AND s.kind = 'usage_recorded') AS usage_settlement_count
           FROM saas_requests r
           JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
           LEFT JOIN saas_usage_events u ON u.tenant_id = r.tenant_id AND u.request_id = r.id AND u.attempt_id = a.id
          WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.proxy_key_id = $3
          ORDER BY r.created_at DESC, a.ordinal DESC
          LIMIT 1`,
      [tenant.id, project.id, platformKey.id],
    );
    assert.equal(platformDurable.rows.length, 1);
    const platformRecord = platformDurable.rows[0];
    assert.ok(platformRecord);
    assert.equal(platformRecord.request_id.length > 0, true);
    assert.equal(platformRecord.entitlement_id, platformEntitlementId);
    assert.equal(platformRecord.supply_profile_id, platformProfileId);
    assert.equal(platformRecord.execution_state, 'succeeded');
    assert.equal(platformRecord.financial_status, 'settled');
    assert.equal(platformRecord.supply_mode, 'platform');
    assert.equal(platformRecord.request_customer_price_version, platformCustomerPrice.id);
    assert.equal(platformRecord.binding_state, 'bound');
    assert.equal(platformRecord.dispatch_authority_state, 'bound');
    assert.equal(platformRecord.account_owner_kind, 'platform');
    assert.equal(platformRecord.tenant_account_id, null);
    assert.equal(platformRecord.platform_account_id, platformAccountId);
    assert.equal(platformRecord.pool_id, platformPoolId);
    assert.equal(platformRecord.attempt_customer_price_version, platformCustomerPrice.id);
    assert.equal(platformRecord.supplier_cost_version, platformSupplierCost.id);
    assert.equal(platformRecord.dispatch_state, 'sent');
    assert.equal(platformRecord.result_state, 'succeeded');
    assert.equal(platformRecord.response_started, true);
    assert.equal(platformRecord.result_http_status, 200);
    assert.equal(platformRecord.usage_status, 'reported');
    assert.equal(platformRecord.usage_source, 'upstream');
    assert.equal(platformRecord.usage_supply_mode, 'platform');
    assert.equal(platformRecord.input_total, '3');
    assert.equal(platformRecord.output_total, '2');
    assert.equal(platformRecord.usage_settlement_count, '1');

    const billing = await seedDatabase.query<{
      reservation_state: string;
      reservation_amount: string;
      settlement_amount: string | null;
      reservation_price_snapshot: string;
      settlement_id: string | null;
      snapshot_price_version: string;
      snapshot_hold_amount: string;
      ledger_source_type: string | null;
      ledger_amount: string | null;
      ledger_price_snapshot: string | null;
      ledger_usage_evidence: string | null;
      ledger_entry_count: string;
    }>(
      `SELECT b.state AS reservation_state,
              b.amount_minor_units::text AS reservation_amount,
              b.settlement_amount_minor_units::text AS settlement_amount,
              b.price_snapshot_ref AS reservation_price_snapshot,
              b.settlement_id,
              s.customer_price_version AS snapshot_price_version,
              s.hold_amount_minor_units::text AS snapshot_hold_amount,
              l.source_type AS ledger_source_type,
              l.amount_minor_units::text AS ledger_amount,
              l.price_snapshot_ref AS ledger_price_snapshot,
              l.usage_evidence_ref AS ledger_usage_evidence,
              (SELECT count(*)::text FROM saas_ledger_entries e WHERE e.transaction_id = l.id) AS ledger_entry_count
         FROM saas_billing_reservations b
         JOIN saas_request_customer_price_snapshots s
           ON s.tenant_id = b.tenant_id AND s.request_id::text = b.request_id
         LEFT JOIN saas_ledger_transactions l
           ON l.tenant_id = b.tenant_id AND l.id = b.ledger_transaction_id
        WHERE b.tenant_id = $1 AND b.request_id = $2
        LIMIT 1`,
      [tenant.id, platformRecord.request_id],
    );
    assert.equal(billing.rows.length, 1);
    const billingRecord = billing.rows[0];
    assert.ok(billingRecord);
    assert.equal(billingRecord.reservation_state, 'settled');
    assert.equal(billingRecord.reservation_amount, '80');
    assert.equal(billingRecord.settlement_amount, '12');
    assert.ok(typeof billingRecord.settlement_id === 'string');
    assert.equal(billingRecord.settlement_id.length > 0, true);
    assert.equal(billingRecord.snapshot_price_version, platformCustomerPrice.id);
    assert.equal(billingRecord.snapshot_hold_amount, '80');
    assert.equal(billingRecord.reservation_price_snapshot, billingRecord.ledger_price_snapshot);
    assert.equal(billingRecord.ledger_source_type, 'billing_settlement');
    assert.equal(billingRecord.ledger_amount, '12');
    assert.match(billingRecord.ledger_usage_evidence ?? '', /^[0-9a-f]{64}$/);
    assert.equal(billingRecord.ledger_entry_count, '2');

    const platformWalletAfter = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(platformWalletAfter, {
      wallets: '1',
      wallet_balance: '988',
      billing_reservations: '1',
      ledger_transactions: '2',
      ledger_entries: '4',
    });

    // FIN-01 HTTP extension starts only after the original streaming BYOK and
    // platform happy paths, including their exact 1000 -> 988 assertions.
    // Four controlled uncertainty scenes follow these six original scenes;
    // malformed/SSE faults and crash recovery remain separate FIN work.
    const observationDatabase = seedDatabase;
    const streamingRequests = [
      {
        mode: 'byok', secret: createdKey.secret, requestId: record.request_id,
        idempotencyKey: `gateway-e2e-request-${ids.label}`,
        body: {
          model: publicModel, messages: [{ role: 'user', content: 'real PostgreSQL gateway integration' }],
          max_tokens: 8, stream: true,
        },
      },
      {
        mode: 'platform', secret: platformKey.secret, requestId: platformRecord.request_id,
        idempotencyKey: `gateway-e2e-platform-request-${ids.label}`,
        body: {
          model: publicModel, messages: [{ role: 'user', content: 'real PostgreSQL platform gateway integration' }],
          max_tokens: 8, stream: true,
        },
      },
    ] as const;
    const postInference = (secret: string, idempotencyKey: string, body: unknown) =>
      fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });

    async function readNonStreamDurable(requestId: string) {
      const result = await observationDatabase.query<{
        execution_state: string; financial_status: string; supply_mode: string;
        proxy_key_id: string; dispatch_state: string; result_state: string; result_http_status: number | null;
        usage_status: string | null; usage_source: string | null; input_total: string | null; output_total: string | null;
        usage_count: string; usage_settlement_count: string; capacity_count: string; held_leases: string;
        canonical_request_id: string; reservation_state: string | null; settlement_amount: string | null;
        snapshot_price_version: string | null; reservation_price_snapshot: string | null;
        ledger_price_snapshot: string | null; ledger_usage_evidence: string | null;
        ledger_amount: string | null; ledger_source: string | null; ledger_entries: string;
        ledger_credit: string; ledger_debit: string;
      }>(
        `SELECT r.execution_state, r.financial_status, r.supply_mode, r.proxy_key_id,
                  a.dispatch_state, a.result_state, a.result_http_status,
                  u.status AS usage_status, u.source AS usage_source,
                  u.input_total::text AS input_total, u.output_total::text AS output_total,
                  (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = r.tenant_id AND request_id = r.id) AS usage_count,
                  (SELECT count(*)::text FROM saas_usage_settlements
                    WHERE tenant_id = r.tenant_id AND request_id = r.id AND kind = 'usage_recorded') AS usage_settlement_count,
                  (SELECT count(*)::text FROM saas_gateway_capacity_reservations
                    WHERE tenant_id = r.tenant_id AND request_id = r.id) AS capacity_count,
                  (SELECT count(*)::text FROM saas_provider_account_leases
                    WHERE tenant_id = r.tenant_id AND attempt_id = a.id::text AND status = 'held') AS held_leases,
                  i.request_id::text AS canonical_request_id, b.state AS reservation_state,
                  b.settlement_amount_minor_units::text AS settlement_amount,
                  s.customer_price_version AS snapshot_price_version,
                  b.price_snapshot_ref AS reservation_price_snapshot,
                  l.price_snapshot_ref AS ledger_price_snapshot, l.usage_evidence_ref AS ledger_usage_evidence,
                  l.amount_minor_units::text AS ledger_amount, l.source_type AS ledger_source,
                  (SELECT count(*)::text FROM saas_ledger_entries WHERE transaction_id = l.id) AS ledger_entries,
                  (SELECT COALESCE(sum(amount_minor_units) FILTER (WHERE direction = 'credit'), 0)::text
                    FROM saas_ledger_entries WHERE transaction_id = l.id) AS ledger_credit,
                  (SELECT COALESCE(sum(amount_minor_units) FILTER (WHERE direction = 'debit'), 0)::text
                    FROM saas_ledger_entries WHERE transaction_id = l.id) AS ledger_debit
             FROM saas_requests r
             JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
             JOIN saas_gateway_request_idempotency_keys i ON i.tenant_id = r.tenant_id AND i.request_id = r.id
             LEFT JOIN saas_usage_events u ON u.tenant_id = r.tenant_id AND u.request_id = r.id AND u.attempt_id = a.id
             LEFT JOIN saas_billing_reservations b ON b.tenant_id = r.tenant_id AND b.request_id = r.id::text
             LEFT JOIN saas_request_customer_price_snapshots s ON s.tenant_id = r.tenant_id AND s.request_id = r.id
             LEFT JOIN saas_ledger_transactions l ON l.tenant_id = r.tenant_id AND l.id = b.ledger_transaction_id
            WHERE r.tenant_id = $1 AND r.id = $2 AND r.project_id = $3`,
        [tenant.id, requestId, project.id],
      );
      assert.ok(result.rows.length <= 1, 'one HTTP request must have at most one attempt and usage event');
      const row = result.rows[0];
      assert.ok(row, 'the completed HTTP dispatch must have a durable request row');
      assert.equal(row.held_leases, '0', 'completed HTTP dispatch must release its provider account lease');
      return row;
    }

    for (const request of streamingRequests) {
      await t.test(`FIN-01 HTTP non-stream ${request.mode} records exact usage and financial effects`, () => dispatchCompletions.preserveFailure(async () => {
        const before = await gatewayEffectSnapshot(observationDatabase, tenant.id);
        const callsBefore = upstreamCallCount;
        const dispatchCheckpoint = dispatchCompletions.checkpoint();
        const body = {
          ...request.body, stream: false,
          messages: [{ role: 'user', content: `real PostgreSQL ${request.mode} non-stream integration` }],
        };
        const response = await postInference(request.secret, `gateway-e2e-${request.mode}-json-${ids.label}`, body);
        const text = await response.text();
        assert.equal(response.status, 200, `non-stream ${request.mode} response: ${text.slice(0, 1000)}`);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
        const completion = JSON.parse(text);
        assert.equal(completion.object, 'chat.completion');
        assert.equal(completion.choices[0]?.message?.content, 'e2e-ok');
        assert.deepEqual(completion.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
        assert.equal(upstreamCallCount, callsBefore + 1);
        assert.equal(upstreamStreams.at(-1), false, 'the actual HTTPS provider payload must request JSON');
        assert.equal(upstreamAuthorizations.at(-1),
          `Bearer ${request.mode === 'platform' ? PLATFORM_PROVIDER_SECRET : PROVIDER_SECRET}`);
        const requestId = response.headers.get('x-request-id');
        assert.ok(requestId, 'the successful HTTP response must identify its durable request');
        await dispatchCompletions.waitForCompletion(requestId, dispatchCheckpoint);
        const durableJson = await readNonStreamDurable(requestId);
        assert.equal(durableJson.execution_state, 'succeeded');
        assert.equal(durableJson.result_state, 'succeeded');
        assert.equal(durableJson.dispatch_state, 'sent');
        assert.equal(durableJson.result_http_status, 200);
        assert.equal(durableJson.supply_mode, request.mode);
        assert.equal(durableJson.proxy_key_id, request.mode === 'platform' ? platformKey.id : createdKey.id);
        assert.equal(durableJson.canonical_request_id, requestId);
        assert.equal(durableJson.usage_status, 'reported');
        assert.equal(durableJson.usage_source, 'upstream');
        assert.equal(durableJson.input_total, '3');
        assert.equal(durableJson.output_total, '2');
        assert.equal(durableJson.usage_count, '1');
        assert.equal(durableJson.usage_settlement_count, '1');
        assert.equal(durableJson.capacity_count, '1');
        const after = await gatewayEffectSnapshot(observationDatabase, tenant.id);
        for (const field of ['requests', 'attempts', 'prepared_evidence', 'usage_events', 'usage_settlements'] as const) {
          assert.equal(BigInt(after.effects[field]), BigInt(before.effects[field]) + 1n, `${field} must grow exactly once`);
        }
        assert.equal(after.effects.capacity.length, before.effects.capacity.length + 1);
        assert.equal(after.effects.provider_leases.length, before.effects.provider_leases.length + 1);
        assert.equal(after.effects.idempotency.length, before.effects.idempotency.length + 1);
        assert.ok(before.wallet && after.wallet);
        if (request.mode === 'byok') {
          assert.equal(durableJson.financial_status, 'not_applicable');
          assert.equal(durableJson.reservation_state, null);
          assert.equal(durableJson.snapshot_price_version, null);
          assert.equal(durableJson.ledger_amount, null);
          assert.equal(durableJson.ledger_entries, '0');
          assert.equal(after.effects.price_snapshots, before.effects.price_snapshots);
          assert.deepEqual(after.wallet, before.wallet, 'non-stream BYOK must leave the platform wallet unchanged');
        } else {
          assert.equal(durableJson.financial_status, 'settled');
          assert.equal(durableJson.reservation_state, 'settled');
          assert.equal(durableJson.settlement_amount, '12');
          assert.equal(durableJson.snapshot_price_version, platformCustomerPrice.id);
          assert.ok(durableJson.reservation_price_snapshot);
          assert.equal(durableJson.ledger_price_snapshot, durableJson.reservation_price_snapshot);
          assert.match(durableJson.ledger_usage_evidence ?? '', /^[0-9a-f]{64}$/);
          assert.equal(durableJson.ledger_source, 'billing_settlement');
          assert.equal(durableJson.ledger_amount, '12');
          assert.equal(durableJson.ledger_entries, '2');
          assert.equal(durableJson.ledger_credit, '12');
          assert.equal(durableJson.ledger_debit, '12');
          assert.deepEqual(after.wallet, {
            wallets: before.wallet.wallets,
            wallet_balance: (BigInt(before.wallet.wallet_balance) - 12n).toString(),
            billing_reservations: (BigInt(before.wallet.billing_reservations) + 1n).toString(),
            ledger_transactions: (BigInt(before.wallet.ledger_transactions) + 1n).toString(),
            ledger_entries: (BigInt(before.wallet.ledger_entries) + 2n).toString(),
          });
          assert.equal(BigInt(after.effects.price_snapshots), BigInt(before.effects.price_snapshots) + 1n);
          assert.equal(after.effects.active_hold, before.effects.active_hold, 'completed JSON settlement must release its hold');
        }
      }));
    }

    await t.test('FIN-01 HTTP durable BYOK/platform replays return canonical references without new effects', () => dispatchCompletions.preserveFailure(async () => {
      const responses: Array<{ mode: string; requestId: string; response: Response; text: string }> = [];
      for (const request of streamingRequests) {
        const before = await gatewayEffectSnapshot(observationDatabase, tenant.id);
        const callsBefore = upstreamCallCount;
        const authorizationsBefore = [...upstreamAuthorizations];
        const streamsBefore = [...upstreamStreams];
        const dispatchCheckpoint = dispatchCompletions.checkpoint();
        const response = await postInference(request.secret, request.idempotencyKey, request.body);
        const text = await response.text();
        dispatchCompletions.assertNoDispatchSince(dispatchCheckpoint);
        const replay = JSON.parse(text);
        assert.equal(response.headers.get('x-canonical-request-id'), request.requestId);
        assert.equal(replay.choices, undefined, 'a canonical reference must not masquerade as a cached completion');
        assert.equal(upstreamCallCount, callsBefore, 'a replay must not dispatch the local provider again');
        assert.deepEqual(upstreamAuthorizations, authorizationsBefore);
        assert.deepEqual(upstreamStreams, streamsBefore);
        assert.deepEqual(await gatewayEffectSnapshot(observationDatabase, tenant.id), before,
          'a replay must not add requests, attempts, usage, wallet postings, holds, capacity, price snapshots or provider leases');
        responses.push({ mode: request.mode, requestId: request.requestId, response, text });
      }
      // Completed canonical requests return status metadata with an explicit
      // response_replayed=false, preserving the existing HTTP product contract.
      for (const { mode, requestId, response, text } of responses) {
        assert.equal(response.status, 200, `${mode} replay response: ${text.slice(0, 1000)}`);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
        assert.deepEqual(JSON.parse(text), {
          object: 'request_status', id: requestId, status: 'completed', response_replayed: false,
        });
      }
    }));

    await t.test('FIN-01 HTTP conflicting BYOK/platform payloads return 409 without financial or dispatch effects', () => dispatchCompletions.preserveFailure(async () => {
      for (const request of streamingRequests) {
        const before = await gatewayEffectSnapshot(observationDatabase, tenant.id);
        const callsBefore = upstreamCallCount;
        const authorizationsBefore = [...upstreamAuthorizations];
        const streamsBefore = [...upstreamStreams];
        const dispatchCheckpoint = dispatchCompletions.checkpoint();
        const response = await postInference(request.secret, request.idempotencyKey, {
          ...request.body, messages: [{ role: 'user', content: 'a conflicting payload must never dispatch' }],
        });
        const text = await response.text();
        dispatchCompletions.assertNoDispatchSince(dispatchCheckpoint);
        assert.equal(response.status, 409, `${request.mode} conflict response: ${text.slice(0, 1000)}`);
        assert.equal(JSON.parse(text).error?.code, 'IDEMPOTENCY_CONFLICT');
        assert.equal(upstreamCallCount, callsBefore);
        assert.deepEqual(upstreamAuthorizations, authorizationsBefore);
        assert.deepEqual(upstreamStreams, streamsBefore);
        assert.deepEqual(await gatewayEffectSnapshot(observationDatabase, tenant.id), before,
          'a fingerprint conflict must leave durable request, usage, billing and capacity effects unchanged');
      }
    }));

    // The original six normal/replay/conflict scenes above remain first.
    // These are controlled network uncertainty cases, not SIGKILL/recovery proof.
    async function readFinancialFaultFacts(
      scope: Awaited<ReturnType<typeof provisionFinancialFaultScope>>, requestId: string,
    ) {
      const result = await observationDatabase.query<{
        request_id: string; execution_state: string; reconciliation_state: string; financial_status: string;
        supply_mode: string; entitlement_id: string; supply_profile_id: string; customer_price_version: string | null;
        attempt_id: string; dispatch_state: string; result_state: string; response_started: boolean;
        result_http_status: number | null; unknown_reason: string | null; binding_state: string;
        dispatch_authority_state: string; account_owner_kind: string; account_id: string; pool_id: string | null;
        supplier_cost_version: string | null; evidence_status: string;
        request_count: string; attempt_count: string; evidence_count: string; usage_count: string; settlement_count: string;
        customer_snapshot_count: string; supplier_snapshot_count: string;
        capacity_state: string; token_units: string; idempotency_state: string; canonical_request_id: string;
        reservation_state: string | null; reservation_amount: string | null; reservation_currency: string | null;
        reservation_snapshot: string | null; hold_snapshot: string | null; hold_amount: string | null;
        settlement_amount: string | null; settlement_id: string | null; ledger_transaction_id: string | null;
        lease_status: string; lease_fencing_token: string; lease_owner_kind: string; lease_owner_tenant_id: string | null;
        account_lease_count: string; held_account_leases: string;
        health_state: string; health_failure_count: number; health_outcome: string; health_revision: string; health_fence: string;
      }>(
        `SELECT r.id AS request_id, r.execution_state, r.reconciliation_state, r.financial_status,
                r.supply_mode, r.entitlement_id, r.supply_profile_id, r.customer_price_version,
                a.id AS attempt_id, a.dispatch_state, a.result_state, a.response_started, a.result_http_status,
                a.unknown_reason, a.binding_state, a.dispatch_authority_state, a.account_owner_kind,
                a.account_id, a.pool_id, a.supplier_cost_version, e.status AS evidence_status,
                (SELECT count(*)::text FROM saas_requests WHERE tenant_id = r.tenant_id) AS request_count,
                (SELECT count(*)::text FROM saas_attempts WHERE tenant_id = r.tenant_id) AS attempt_count,
                (SELECT count(*)::text FROM saas_prepared_request_evidence WHERE tenant_id = r.tenant_id) AS evidence_count,
                (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = r.tenant_id) AS usage_count,
                (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = r.tenant_id) AS settlement_count,
                (SELECT count(*)::text FROM saas_request_customer_price_snapshots
                  WHERE tenant_id = r.tenant_id) AS customer_snapshot_count,
                (SELECT count(*)::text FROM saas_attempt_supplier_cost_snapshots
                  WHERE tenant_id = r.tenant_id) AS supplier_snapshot_count,
                c.state AS capacity_state, c.token_units::text AS token_units,
                i.state AS idempotency_state, i.request_id::text AS canonical_request_id,
                b.state AS reservation_state, b.amount_minor_units::text AS reservation_amount,
                b.currency AS reservation_currency, b.price_snapshot_ref AS reservation_snapshot,
                s.id AS hold_snapshot, s.hold_amount_minor_units::text AS hold_amount,
                b.settlement_amount_minor_units::text AS settlement_amount, b.settlement_id, b.ledger_transaction_id,
                l.status AS lease_status, l.fencing_token::text AS lease_fencing_token,
                l.owner_kind AS lease_owner_kind, l.owner_tenant_id::text AS lease_owner_tenant_id,
                (SELECT count(*)::text FROM saas_provider_account_leases
                  WHERE account_id = a.account_id AND tenant_id = r.tenant_id) AS account_lease_count,
                (SELECT count(*)::text FROM saas_provider_account_leases
                  WHERE account_id = a.account_id AND tenant_id = r.tenant_id AND status = 'held') AS held_account_leases,
                h.state AS health_state, h.failure_count AS health_failure_count, h.last_outcome AS health_outcome,
                h.revision::text AS health_revision, h.source_fencing_token::text AS health_fence
           FROM saas_requests r
           JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
           JOIN saas_prepared_request_evidence e
             ON e.tenant_id = r.tenant_id AND e.attempt_id = a.id AND e.id = a.prepared_evidence_id
           JOIN saas_gateway_capacity_reservations c
             ON c.tenant_id = r.tenant_id AND c.request_id = r.id AND c.attempt_id = a.id
           JOIN saas_gateway_request_idempotency_keys i
             ON i.tenant_id = r.tenant_id AND i.project_id = r.project_id AND i.proxy_key_id = r.proxy_key_id AND i.request_id = r.id
           JOIN saas_provider_account_leases l
             ON l.tenant_id = r.tenant_id AND l.attempt_id = a.id::text AND l.account_id = a.account_id
           JOIN saas_provider_account_runtime_health h
             ON h.account_id = a.account_id AND h.owner_kind = a.account_owner_kind
            AND h.owner_tenant_id IS NOT DISTINCT FROM l.owner_tenant_id
           LEFT JOIN saas_billing_reservations b ON b.tenant_id = r.tenant_id AND b.request_id = r.id::text
           LEFT JOIN saas_request_customer_price_snapshots s ON s.tenant_id = r.tenant_id AND s.request_id = r.id
          WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.proxy_key_id = $3 AND r.id = $4`,
        [scope.context.tenantId, scope.context.projectId, scope.key.id, requestId],
      );
      assert.equal(result.rows.length, 1, 'one exact fault request must join one attempt/evidence/lease/reservation mapping');
      const row = result.rows[0];
      assert.ok(row);
      return row;
    }

    let completedFaultScenes = 0;
    for (const scope of financialFaultScopes) {
      await t.test(`FIN-01 real HTTP ${scope.mode} ${scope.kind} retains uncertainty without charging`,
        () => dispatchCompletions.preserveFailure(async () => {
          // Probe the dedicated account immediately before its own request:
          // no stale-health workaround, fake health, or direct health insert.
          const probeAttemptId = randomUUID();
          const ownerKind = scope.mode === 'platform' ? 'platform' : 'tenant';
          const evidence: PreparedRequestEvidenceRecord = {
            ...probeEvidence, tenantId: scope.context.tenantId, projectId: scope.context.projectId,
            requestId: randomUUID(), attemptId: probeAttemptId, evidenceId: randomUUID(),
            accountId: scope.accountId, upstreamId: scope.upstreamId, supplyMode: scope.mode, accountOwnerKind: ownerKind,
          };
          const lease = await leaseService.acquire({
            tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
            attemptId: probeAttemptId, evidence,
          });
          assert.ok(lease, 'the independent account must acquire a real native probe lease');
          try {
            assert.equal(await health.recordRuntimeOutcome({
              candidate: {
                tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
                supplyMode: scope.mode, accountOwnerKind: ownerKind,
              },
              attemptId: probeAttemptId, fencingToken: lease.fencingToken, evidence: { source: 'probe', result: 'success' },
            }), 'applied');
          } finally { await lease.release(); }

          const before = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(before.wallet);
          assert.deepEqual(before.wallet, scope.mode === 'platform'
            ? { wallets: '1', wallet_balance: '1000', billing_reservations: '0', ledger_transactions: '1', ledger_entries: '2' }
            : { wallets: '0', wallet_balance: '0', billing_reservations: '0', ledger_transactions: '0', ledger_entries: '0' });
          for (const count of ['requests', 'attempts', 'prepared_evidence', 'usage_events', 'usage_settlements', 'price_snapshots'] as const) {
            assert.equal(before.effects[count], '0');
          }
          assert.deepEqual(before.effects.capacity, []);
          assert.deepEqual(before.effects.idempotency, []);
          const network = financialFaults.register({ kind: scope.kind });
          const body = {
            model: publicModel, messages: [{ role: 'user', content: network.prompt }], max_tokens: 8, stream: false,
          };
          const idempotencyKey = `fin-http-${randomUUID()}`;
          const controller = new AbortController();
          const checkpoint = dispatchCompletions.checkpoint();
          const callsBefore = upstreamCallCount;
          // Attach a rejection handler immediately; receipt waiting must not
          // leave an unhandled fetch rejection or mistake any error for cancellation.
          const http = fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${scope.key.secret}`,
              'content-type': 'application/json', 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          }).then(
            (response) => ({ kind: 'response' as const, response }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          );
          let requestId: string;
          try {
            await network.waitFor('receipt');
            requestId = dispatchCompletions.requestIdSince(checkpoint);
            assert.equal(network.snapshot().receipts, 1);
            if (scope.kind === 'before_headers_cancel') {
              // Receipt proves possible send; the fixture has emitted no
              // headers/body, so this is not a pre-dispatch compensation test.
              assert.equal(network.snapshot().headers, 0);
              assert.equal(network.snapshot().bytesWritten, 0);
              controller.abort();
              const cancelled = await http;
              assert.equal(cancelled.kind, 'error', 'receipt-before-headers cancellation must not receive a response');
              assert.ok(cancelled.kind === 'error' && cancelled.error instanceof Error && cancelled.error.name === 'AbortError',
                'only the explicitly requested client abort is accepted');
            } else {
              const completed = await http;
              assert.equal(completed.kind, 'response', 'missing usage must still deliver the genuine complete JSON response');
              assert.ok(completed.kind === 'response');
              assert.equal(completed.response.status, 200);
              assert.equal(completed.response.headers.get('x-request-id'), requestId);
              assert.match(completed.response.headers.get('content-type') ?? '', /application\/json/i);
              const json = JSON.parse(await completed.response.text());
              assert.equal(json.object, 'chat.completion');
              assert.equal(json.choices[0]?.message?.content, 'financial-fault-fixture');
              assert.equal(json.usage, undefined);
              await network.waitFor('eof');
            }
            // Observe real finalization, not client/upstream EOF. Unknown is
            // expected explicitly; sent, rejection, release failure or timeout fails.
            await dispatchCompletions.waitForCompletion(requestId, checkpoint, 'unknown');
            await network.waitFor('close');
          } finally { controller.abort(); }

          const wire = network.snapshot();
          assert.equal(wire.receipts, 1);
          assert.equal(wire.headers, scope.kind === 'json_missing_usage' ? 1 : 0);
          assert.equal(wire.firstChunks, scope.kind === 'json_missing_usage' ? 1 : 0);
          assert.equal(wire.eofs, scope.kind === 'json_missing_usage' ? 1 : 0);
          assert.equal(wire.peerCancellations, scope.kind === 'before_headers_cancel' ? 1 : 0);
          assert.equal(wire.closes, 1);
          assert.equal(wire.protocolMismatches, 0);
          assert.equal(wire.watchdogCloses, 0);
          assert.equal(wire.cleanupCloses, 0);
          assert.equal(wire.writeErrors, 0);
          assert.equal(wire.activeResponses, 0);
          assert.equal(wire.pendingWaits, 0);
          assert.equal(upstreamCallCount, callsBefore + 1);
          assert.equal(upstreamStreams.at(-1), false);
          assert.equal(upstreamAuthorizations.at(-1),
            `Bearer ${scope.mode === 'platform' ? PLATFORM_PROVIDER_SECRET : PROVIDER_SECRET}`);

          const facts = await readFinancialFaultFacts(scope, requestId);
          assert.equal(facts.request_id, requestId);
          assert.equal(facts.execution_state, 'unknown');
          assert.equal(facts.reconciliation_state, 'pending');
          assert.equal(facts.supply_mode, scope.mode);
          assert.equal(facts.entitlement_id, scope.entitlementId);
          assert.equal(facts.supply_profile_id, scope.profileId);
          assert.equal(facts.dispatch_state, 'unknown');
          assert.equal(facts.result_state, 'unknown');
          assert.equal(facts.unknown_reason, scope.kind === 'json_missing_usage' ? 'usage_missing' : 'dispatch_uncertain');
          assert.equal(facts.response_started, scope.kind === 'json_missing_usage');
          assert.equal(facts.result_http_status, scope.kind === 'json_missing_usage' ? 200 : null);
          assert.equal(facts.binding_state, 'bound');
          assert.equal(facts.dispatch_authority_state, 'bound');
          assert.equal(facts.account_owner_kind, ownerKind);
          assert.equal(facts.account_id, scope.accountId);
          assert.equal(facts.pool_id, scope.mode === 'platform' ? scope.upstreamId : null);
          assert.equal(facts.evidence_status, 'claimed');
          assert.equal(facts.request_count, '1');
          assert.equal(facts.attempt_count, '1');
          assert.equal(facts.evidence_count, '1');
          assert.equal(facts.usage_count, '0', 'unobserved usage must not become guessed or zero usage');
          assert.equal(facts.settlement_count, '0');
          assert.equal(facts.supplier_snapshot_count, '0', 'no supplier cost may be manufactured from missing usage');
          // Current uncertainty persistence retains the original capacity and
          // idempotency reservations; canonical status derives from the request.
          assert.equal(facts.capacity_state, 'reserved');
          assert.equal(facts.token_units, '32');
          assert.equal(facts.idempotency_state, 'in_progress');
          assert.equal(facts.canonical_request_id, requestId);
          assert.equal(facts.lease_status, 'released');
          assert.equal(facts.lease_owner_kind, ownerKind);
          assert.equal(facts.lease_owner_tenant_id, scope.mode === 'platform' ? null : scope.context.tenantId);
          assert.equal(facts.account_lease_count, '2', 'only the probe and one actual dispatch lease are allowed');
          assert.equal(facts.held_account_leases, '0');
          assert.equal(facts.health_state, 'healthy');
          assert.equal(facts.health_failure_count, 0);
          // A missing-usage HTTP 200 is a transport success, not financial
          // success. Explicit client abort is not a provider network failure.
          assert.equal(facts.health_outcome, scope.kind === 'json_missing_usage' ? 'gateway_success' : 'probe_success');
          assert.equal(facts.health_revision, scope.kind === 'json_missing_usage' ? '2' : '1');
          assert.equal(facts.health_fence, scope.kind === 'json_missing_usage' ? facts.lease_fencing_token : lease.fencingToken);
          assert.equal(facts.settlement_amount, null);
          assert.equal(facts.settlement_id, null);
          assert.equal(facts.ledger_transaction_id, null);
          const after = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(after.wallet);
          if (scope.mode === 'platform') {
            assert.equal(facts.financial_status, 'reconciliation_pending');
            assert.equal(facts.customer_price_version, platformCustomerPrice.id);
            assert.equal(facts.supplier_cost_version, platformSupplierCost.id);
            assert.equal(facts.customer_snapshot_count, '1');
            assert.equal(facts.reservation_state, 'reconciliation_pending');
            assert.equal(facts.reservation_currency, 'USD');
            assert.equal(facts.reservation_amount, '80');
            assert.equal(facts.hold_amount, '80');
            assert.ok(facts.reservation_snapshot);
            assert.equal(facts.reservation_snapshot, facts.hold_snapshot);
            assert.equal(after.effects.active_hold, '80');
            assert.deepEqual(after.wallet, { ...before.wallet, billing_reservations: '1' },
              'retain all 80 units without a charge/refund or new ledger pair');
          } else {
            assert.equal(facts.financial_status, 'not_applicable');
            assert.equal(facts.customer_price_version, null);
            assert.equal(facts.supplier_cost_version, null);
            assert.equal(facts.customer_snapshot_count, '0');
            assert.equal(facts.reservation_state, null);
            assert.equal(facts.reservation_amount, null);
            assert.equal(facts.reservation_currency, null);
            assert.equal(facts.reservation_snapshot, null);
            assert.equal(facts.hold_snapshot, null);
            assert.equal(facts.hold_amount, null);
            assert.equal(after.effects.active_hold, '0');
            assert.deepEqual(after.wallet, before.wallet, 'BYOK uncertainty must create no token wallet or financial effect');
          }

          const replayCheckpoint = dispatchCompletions.checkpoint();
          const replay = await postInference(scope.key.secret, idempotencyKey, body);
          const replayText = await replay.text();
          dispatchCompletions.assertNoDispatchSince(replayCheckpoint);
          assert.equal(replay.status, 202);
          assert.equal(replay.headers.get('x-canonical-request-id'), requestId);
          assert.deepEqual(JSON.parse(replayText),
            { object: 'request_status', id: requestId, status: 'unknown', response_replayed: false });
          assert.equal(upstreamCallCount, callsBefore + 1, 'unknown replay must never redispatch');
          assert.equal(network.snapshot().receipts, 1);
          assert.deepEqual(await readFinancialFaultFacts(scope, requestId), facts);
          assert.deepEqual(await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId), after,
            'unknown replay must preserve hold, capacity, idempotency, usage, lease, health and all ledger facts');
          completedFaultScenes += 1;
        }));
    }
    assert.equal(completedFaultScenes, 4, 'all four HTTP faults must reach every financial assertion');

    // Two further independent tenants exercise cancellation after actual SSE
    // delivery; none of the ten preceding scene assertions are replaced.
    let completedSseFaultScenes = 0;
    for (const scope of sseFinancialFaultScopes) {
      await t.test(`FIN-01 real HTTP ${scope.mode} SSE first-frame cancellation retains uncertainty`,
        () => dispatchCompletions.preserveFailure(async () => {
          // Probe the dedicated account immediately before its own request:
          // no stale-health workaround, fake health, or direct health insert.
          const probeAttemptId = randomUUID();
          const ownerKind = scope.mode === 'platform' ? 'platform' : 'tenant';
          const evidence: PreparedRequestEvidenceRecord = {
            ...probeEvidence, tenantId: scope.context.tenantId, projectId: scope.context.projectId,
            requestId: randomUUID(), attemptId: probeAttemptId, evidenceId: randomUUID(),
            accountId: scope.accountId, upstreamId: scope.upstreamId, supplyMode: scope.mode, accountOwnerKind: ownerKind,
          };
          const lease = await leaseService.acquire({
            tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
            attemptId: probeAttemptId, evidence,
          });
          assert.ok(lease, 'the independent account must acquire a real native probe lease');
          try {
            assert.equal(await health.recordRuntimeOutcome({
              candidate: {
                tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
                supplyMode: scope.mode, accountOwnerKind: ownerKind,
              },
              attemptId: probeAttemptId, fencingToken: lease.fencingToken, evidence: { source: 'probe', result: 'success' },
            }), 'applied');
          } finally { await lease.release(); }

          const before = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(before.wallet);
          assert.deepEqual(before.wallet, scope.mode === 'platform'
            ? { wallets: '1', wallet_balance: '1000', billing_reservations: '0', ledger_transactions: '1', ledger_entries: '2' }
            : { wallets: '0', wallet_balance: '0', billing_reservations: '0', ledger_transactions: '0', ledger_entries: '0' });
          for (const count of ['requests', 'attempts', 'prepared_evidence', 'usage_events', 'usage_settlements', 'price_snapshots'] as const) {
            assert.equal(before.effects[count], '0');
          }
          assert.deepEqual(before.effects.capacity, []);
          assert.deepEqual(before.effects.idempotency, []);
          const network = financialFaults.register({ kind: 'sse_partial_cancel' });
          const body = {
            model: publicModel, messages: [{ role: 'user', content: network.prompt }], max_tokens: 8, stream: true,
          };
          const idempotencyKey = `fin-sse-${randomUUID()}`;
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
          const checkpoint = dispatchCompletions.checkpoint();
          const callsBefore = upstreamCallCount;
          const http = fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${scope.key.secret}`,
              'content-type': 'application/json', 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body), signal,
          }).then(
            (response) => ({ kind: 'response' as const, response }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          );
          let requestId: string;
          let consumedBytes = 0;
          try {
            await network.waitFor('receipt');
            requestId = dispatchCompletions.requestIdSince(checkpoint);
            await network.waitFor('first_chunk');
            const delivered = await http;
            assert.equal(delivered.kind, 'response', 'partial cancellation requires a genuine delivered SSE response');
            assert.ok(delivered.kind === 'response');
            assert.equal(delivered.response.status, 200);
            assert.equal(delivered.response.headers.get('x-request-id'), requestId);
            assert.match(delivered.response.headers.get('content-type') ?? '', /text\/event-stream/i);
            assert.ok(delivered.response.body);
            const reader = delivered.response.body.getReader();
            try {
              // Consume a complete, bounded data frame before cancellation;
              // receipt, headers or an upstream write alone are not delivery proof.
              let frame: Buffer = Buffer.alloc(0);
              while (frame.indexOf('\n\n') === -1) {
                const next = await reader.read();
                assert.equal(next.done, false, 'the fixture must not end the stream before client cancellation');
                assert.ok(next.value instanceof Uint8Array);
                consumedBytes += next.value.byteLength;
                assert.ok(consumedBytes <= 4_096, 'the first SSE frame must remain bounded');
                frame = Buffer.concat([frame, next.value]);
              }
              const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
              assert.equal(text.indexOf('\n\n'), text.length - 2, 'consume exactly the fixture first frame, not a terminal stream');
              assert.ok(text.startsWith('data: '));
              assert.equal(text.includes('[DONE]'), false);
              const firstEvent = JSON.parse(text.slice(6, -2));
              assert.equal(firstEvent.object, 'chat.completion.chunk');
              assert.deepEqual(firstEvent.choices, [
                { index: 0, delta: { content: 'financial-fault-first-chunk' }, finish_reason: null },
              ]);
              assert.equal(firstEvent.usage, undefined);
              const beforeCancel = network.snapshot();
              assert.equal(beforeCancel.receipts, 1);
              assert.equal(beforeCancel.headers, 1);
              assert.equal(beforeCancel.firstChunks, 1);
              assert.equal(beforeCancel.bytesWritten, consumedBytes);
              assert.equal(beforeCancel.eofs, 0);
              assert.equal(beforeCancel.closes, 0);
              assert.equal(beforeCancel.peerCancellations, 0);
              assert.equal(beforeCancel.watchdogCloses, 0);
              assert.equal(beforeCancel.cleanupCloses, 0);
              assert.equal(signal.aborted, false, 'a timeout must not masquerade as the explicit client cancellation');
              controller.abort();
            } finally { reader.releaseLock(); }
            // This exact real dispatch must persist unknown and release its
            // lease; a sent result, rejection, release failure or timeout fails.
            await dispatchCompletions.waitForCompletion(requestId, checkpoint, 'unknown');
            await network.waitFor('close');
          } finally { controller.abort(); }

          const wire = network.snapshot();
          assert.equal(wire.receipts, 1);
          assert.equal(wire.headers, 1);
          assert.equal(wire.firstChunks, 1);
          assert.equal(wire.bytesWritten, consumedBytes);
          assert.ok(consumedBytes > 0);
          assert.equal(wire.eofs, 0);
          assert.equal(wire.peerCancellations, 1, 'only a genuine peer cancellation, not cleanup/watchdog EOF, is accepted');
          assert.equal(wire.closes, 1);
          assert.equal(wire.protocolMismatches, 0);
          assert.equal(wire.watchdogCloses, 0);
          assert.equal(wire.cleanupCloses, 0);
          assert.equal(wire.writeErrors, 0);
          assert.equal(wire.activeResponses, 0);
          assert.equal(wire.pendingWaits, 0);
          assert.equal(upstreamCallCount, callsBefore + 1);
          assert.equal(upstreamStreams.at(-1), true);
          assert.equal(upstreamAuthorizations.at(-1),
            `Bearer ${scope.mode === 'platform' ? PLATFORM_PROVIDER_SECRET : PROVIDER_SECRET}`);

          const facts = await readFinancialFaultFacts(scope, requestId);
          assert.equal(facts.request_id, requestId);
          assert.equal(facts.execution_state, 'unknown');
          assert.equal(facts.reconciliation_state, 'pending');
          assert.equal(facts.supply_mode, scope.mode);
          assert.equal(facts.entitlement_id, scope.entitlementId);
          assert.equal(facts.supply_profile_id, scope.profileId);
          assert.equal(facts.dispatch_state, 'unknown');
          assert.equal(facts.result_state, 'unknown');
          assert.equal(facts.unknown_reason, 'dispatch_uncertain');
          assert.equal(facts.response_started, true);
          // Client headers were committed, but partial delivery never reached the sent transition.
          assert.equal(facts.result_http_status, null);
          assert.equal(facts.binding_state, 'bound');
          assert.equal(facts.dispatch_authority_state, 'bound');
          assert.equal(facts.account_owner_kind, ownerKind);
          assert.equal(facts.account_id, scope.accountId);
          assert.equal(facts.pool_id, scope.mode === 'platform' ? scope.upstreamId : null);
          assert.equal(facts.evidence_status, 'claimed');
          assert.equal(facts.request_count, '1');
          assert.equal(facts.attempt_count, '1');
          assert.equal(facts.evidence_count, '1');
          assert.equal(facts.usage_count, '0', 'unobserved usage must not become guessed or zero usage');
          assert.equal(facts.settlement_count, '0');
          assert.equal(facts.supplier_snapshot_count, '0', 'no supplier cost may be manufactured from missing usage');
          // Current uncertainty persistence retains the original capacity and
          // idempotency reservations; canonical status derives from the request.
          assert.equal(facts.capacity_state, 'reserved');
          assert.equal(facts.token_units, '32');
          assert.equal(facts.idempotency_state, 'in_progress');
          assert.equal(facts.canonical_request_id, requestId);
          assert.equal(facts.lease_status, 'released');
          assert.equal(facts.lease_owner_kind, ownerKind);
          assert.equal(facts.lease_owner_tenant_id, scope.mode === 'platform' ? null : scope.context.tenantId);
          assert.equal(facts.account_lease_count, '2', 'only the probe and one actual dispatch lease are allowed');
          assert.equal(facts.held_account_leases, '0');
          assert.equal(facts.health_state, 'healthy');
          assert.equal(facts.health_failure_count, 0);
          // Current health records the observed upstream 200 as transport success;
          // neither that record nor a delivered chunk is trusted financial usage.
          assert.equal(facts.health_outcome, 'gateway_success');
          assert.equal(facts.health_revision, '2');
          assert.equal(facts.health_fence, facts.lease_fencing_token);
          assert.equal(facts.settlement_amount, null);
          assert.equal(facts.settlement_id, null);
          assert.equal(facts.ledger_transaction_id, null);
          const after = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(after.wallet);
          if (scope.mode === 'platform') {
            assert.equal(facts.financial_status, 'reconciliation_pending');
            assert.equal(facts.customer_price_version, platformCustomerPrice.id);
            assert.equal(facts.supplier_cost_version, platformSupplierCost.id);
            assert.equal(facts.customer_snapshot_count, '1');
            assert.equal(facts.reservation_state, 'reconciliation_pending');
            assert.equal(facts.reservation_currency, 'USD');
            assert.equal(facts.reservation_amount, '80');
            assert.equal(facts.hold_amount, '80');
            assert.ok(facts.reservation_snapshot);
            assert.equal(facts.reservation_snapshot, facts.hold_snapshot);
            assert.equal(after.effects.active_hold, '80');
            assert.deepEqual(after.wallet, { ...before.wallet, billing_reservations: '1' },
              'retain all 80 units without a charge/refund or new ledger pair');
          } else {
            assert.equal(facts.financial_status, 'not_applicable');
            assert.equal(facts.customer_price_version, null);
            assert.equal(facts.supplier_cost_version, null);
            assert.equal(facts.customer_snapshot_count, '0');
            assert.equal(facts.reservation_state, null);
            assert.equal(facts.reservation_amount, null);
            assert.equal(facts.reservation_currency, null);
            assert.equal(facts.reservation_snapshot, null);
            assert.equal(facts.hold_snapshot, null);
            assert.equal(facts.hold_amount, null);
            assert.equal(after.effects.active_hold, '0');
            assert.deepEqual(after.wallet, before.wallet, 'BYOK uncertainty must create no token wallet or financial effect');
          }

          const replayCheckpoint = dispatchCompletions.checkpoint();
          const replay = await postInference(scope.key.secret, idempotencyKey, body);
          const replayText = await replay.text();
          dispatchCompletions.assertNoDispatchSince(replayCheckpoint);
          assert.equal(replay.status, 202);
          assert.equal(replay.headers.get('x-canonical-request-id'), requestId);
          assert.deepEqual(JSON.parse(replayText),
            { object: 'request_status', id: requestId, status: 'unknown', response_replayed: false });
          assert.equal(upstreamCallCount, callsBefore + 1, 'unknown replay must never redispatch');
          assert.equal(network.snapshot().receipts, 1);
          assert.deepEqual(network.snapshot(), wire, 'unknown replay must not reopen or advance the cancelled upstream');
          assert.deepEqual(await readFinancialFaultFacts(scope, requestId), facts);
          assert.deepEqual(await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId), after,
            'unknown replay must preserve hold, capacity, idempotency, usage, lease, health and all ledger facts');
          completedSseFaultScenes += 1;
        }));
    }
    assert.equal(completedSseFaultScenes, 2, 'both SSE cancellation scenes must reach every financial assertion');

    // Sixteen additional independent cases preserve the twelve preceding
    // scenes and prove each complete invalid-usage response is non-billable.
    let completedInvalidJsonUsageScenes = 0;
    const invalidJsonUsageNonces = new Set<string>();
    for (const scope of invalidJsonUsageScopes) {
      await t.test(`FIN-01 real HTTP ${scope.mode} invalid JSON usage ${scope.usageCase.variant} retains uncertainty`,
        () => dispatchCompletions.preserveFailure(async () => {
          // Probe the dedicated account immediately before its own request:
          // no stale-health workaround, fake health, or direct health insert.
          const probeAttemptId = randomUUID();
          const ownerKind = scope.mode === 'platform' ? 'platform' : 'tenant';
          const evidence: PreparedRequestEvidenceRecord = {
            ...probeEvidence, tenantId: scope.context.tenantId, projectId: scope.context.projectId,
            requestId: randomUUID(), attemptId: probeAttemptId, evidenceId: randomUUID(),
            accountId: scope.accountId, upstreamId: scope.upstreamId, supplyMode: scope.mode, accountOwnerKind: ownerKind,
          };
          const lease = await leaseService.acquire({
            tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
            attemptId: probeAttemptId, evidence,
          });
          assert.ok(lease, 'the independent account must acquire a real native probe lease');
          try {
            assert.equal(await health.recordRuntimeOutcome({
              candidate: {
                tenantId: scope.context.tenantId, accountId: scope.accountId, upstreamId: scope.upstreamId,
                supplyMode: scope.mode, accountOwnerKind: ownerKind,
              },
              attemptId: probeAttemptId, fencingToken: lease.fencingToken, evidence: { source: 'probe', result: 'success' },
            }), 'applied');
          } finally { await lease.release(); }

          const before = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(before.wallet);
          assert.deepEqual(before.wallet, scope.mode === 'platform'
            ? { wallets: '1', wallet_balance: '1000', billing_reservations: '0', ledger_transactions: '1', ledger_entries: '2' }
            : { wallets: '0', wallet_balance: '0', billing_reservations: '0', ledger_transactions: '0', ledger_entries: '0' });
          for (const count of ['requests', 'attempts', 'prepared_evidence', 'usage_events', 'usage_settlements', 'price_snapshots'] as const) {
            assert.equal(before.effects[count], '0');
          }
          assert.deepEqual(before.effects.capacity, []);
          assert.deepEqual(before.effects.idempotency, []);
          assert.equal(scope.kind, 'json_invalid_usage');
          const network = financialFaults.register({ kind: 'json_invalid_usage', variant: scope.usageCase.variant });
          assert.equal(invalidJsonUsageNonces.has(network.nonce), false, 'each invalid-usage HTTP scene needs a new nonce');
          invalidJsonUsageNonces.add(network.nonce);
          const body = {
            model: publicModel, messages: [{ role: 'user', content: network.prompt }], max_tokens: 8, stream: false,
          };
          const idempotencyKey = `fin-invalid-json-${randomUUID()}`;
          const controller = new AbortController();
          const checkpoint = dispatchCompletions.checkpoint();
          const callsBefore = upstreamCallCount;
          const http = fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${scope.key.secret}`,
              'content-type': 'application/json', 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          }).then(
            (response) => ({ kind: 'response' as const, response }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          );
          let requestId: string;
          let consumedBytes = 0;
          try {
            await network.waitFor('receipt');
            requestId = dispatchCompletions.requestIdSince(checkpoint);
            const delivered = await http;
            assert.equal(delivered.kind, 'response', 'invalid usage must be a genuine complete HTTP response, not a transport error');
            assert.ok(delivered.kind === 'response');
            assert.equal(delivered.response.status, 200);
            assert.equal(delivered.response.headers.get('x-request-id'), requestId);
            assert.match(delivered.response.headers.get('content-type') ?? '', /application\/json/i);
            const responseText = await delivered.response.text();
            consumedBytes = Buffer.byteLength(responseText);
            assert.ok(consumedBytes > 0 && consumedBytes <= 4_096);
            const envelope = {
              id: `chatcmpl-financial-fault-${network.nonce}`, object: 'chat.completion', created: 1, model: providerModel,
              choices: [{ index: 0, message: { role: 'assistant', content: 'financial-fault-fixture' }, finish_reason: 'stop' }],
            };
            const usageJson = JSON.stringify(scope.usageCase.usage);
            const expectedBody = scope.usageCase.variant === 'duplicate_usage'
              ? `${JSON.stringify(envelope).slice(0, -1)},"usage":${usageJson},"usage":${usageJson}}`
              : JSON.stringify({ ...envelope, usage: scope.usageCase.usage });
            // A boolean exact-byte oracle avoids exposing the raw body in an
            // assertion. Duplicate usage must be checked BEFORE JSON.parse:
            // its two individually valid reports must not be collapsed to one.
            assert.equal(responseText === expectedBody, true, 'the exact registered invalid usage must reach the client unchanged');
            const json = JSON.parse(responseText);
            assert.equal(json.object, 'chat.completion');
            assert.equal(json.choices[0]?.message?.content, 'financial-fault-fixture');
            assert.equal(json.choices[0]?.finish_reason, 'stop');
            assert.deepEqual(json.usage, scope.usageCase.usage);
            await network.waitFor('eof');
            // Full client/upstream EOF is not financial completion. Require
            // this exact dispatch to persist unknown, without a release error.
            await dispatchCompletions.waitForCompletion(requestId, checkpoint, 'unknown');
            await network.waitFor('close');
          } finally { controller.abort(); }

          const wire = network.snapshot();
          assert.equal(wire.receipts, 1);
          assert.equal(wire.headers, 1);
          assert.equal(wire.firstChunks, 1);
          assert.equal(wire.bytesWritten, consumedBytes);
          assert.equal(wire.eofs, 1);
          assert.equal(wire.peerCancellations, 0);
          assert.equal(wire.closes, 1);
          assert.equal(wire.protocolMismatches, 0);
          assert.equal(wire.watchdogCloses, 0);
          assert.equal(wire.cleanupCloses, 0);
          assert.equal(wire.writeErrors, 0);
          assert.equal(wire.activeResponses, 0);
          assert.equal(wire.pendingWaits, 0);
          assert.equal(upstreamCallCount, callsBefore + 1);
          assert.equal(upstreamStreams.at(-1), false);
          assert.equal(upstreamAuthorizations.at(-1),
            `Bearer ${scope.mode === 'platform' ? PLATFORM_PROVIDER_SECRET : PROVIDER_SECRET}`);

          const facts = await readFinancialFaultFacts(scope, requestId);
          assert.equal(facts.request_id, requestId);
          assert.equal(facts.execution_state, 'unknown');
          assert.equal(facts.reconciliation_state, 'pending');
          assert.equal(facts.supply_mode, scope.mode);
          assert.equal(facts.entitlement_id, scope.entitlementId);
          assert.equal(facts.supply_profile_id, scope.profileId);
          assert.equal(facts.dispatch_state, 'unknown');
          assert.equal(facts.result_state, 'unknown');
          assert.equal(facts.unknown_reason, 'usage_missing');
          assert.equal(facts.response_started, true);
          assert.equal(facts.result_http_status, 200);
          assert.equal(facts.binding_state, 'bound');
          assert.equal(facts.dispatch_authority_state, 'bound');
          assert.equal(facts.account_owner_kind, ownerKind);
          assert.equal(facts.account_id, scope.accountId);
          assert.equal(facts.pool_id, scope.mode === 'platform' ? scope.upstreamId : null);
          assert.equal(facts.evidence_status, 'claimed');
          assert.equal(facts.request_count, '1');
          assert.equal(facts.attempt_count, '1');
          assert.equal(facts.evidence_count, '1');
          assert.equal(facts.usage_count, '0', 'unobserved usage must not become guessed or zero usage');
          assert.equal(facts.settlement_count, '0');
          assert.equal(facts.supplier_snapshot_count, '0', 'no supplier cost may be manufactured from invalid usage');
          // Current uncertainty persistence retains the original capacity and
          // idempotency reservations; canonical status derives from the request.
          assert.equal(facts.capacity_state, 'reserved');
          assert.equal(facts.token_units, '32');
          assert.equal(facts.idempotency_state, 'in_progress');
          assert.equal(facts.canonical_request_id, requestId);
          assert.equal(facts.lease_status, 'released');
          assert.equal(facts.lease_owner_kind, ownerKind);
          assert.equal(facts.lease_owner_tenant_id, scope.mode === 'platform' ? null : scope.context.tenantId);
          assert.equal(facts.account_lease_count, '2', 'only the probe and one actual dispatch lease are allowed');
          assert.equal(facts.held_account_leases, '0');
          assert.equal(facts.health_state, 'healthy');
          assert.equal(facts.health_failure_count, 0);
          // A complete HTTP 200 containing invalid/ambiguous usage is a
          // transport success, never a trusted financial usage report.
          assert.equal(facts.health_outcome, 'gateway_success');
          assert.equal(facts.health_revision, '2');
          assert.equal(facts.health_fence, facts.lease_fencing_token);
          assert.equal(facts.settlement_amount, null);
          assert.equal(facts.settlement_id, null);
          assert.equal(facts.ledger_transaction_id, null);
          const after = await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId);
          assert.ok(after.wallet);
          if (scope.mode === 'platform') {
            assert.equal(facts.financial_status, 'reconciliation_pending');
            assert.equal(facts.customer_price_version, platformCustomerPrice.id);
            assert.equal(facts.supplier_cost_version, platformSupplierCost.id);
            assert.equal(facts.customer_snapshot_count, '1');
            assert.equal(facts.reservation_state, 'reconciliation_pending');
            assert.equal(facts.reservation_currency, 'USD');
            assert.equal(facts.reservation_amount, '80');
            assert.equal(facts.hold_amount, '80');
            assert.ok(facts.reservation_snapshot);
            assert.equal(facts.reservation_snapshot, facts.hold_snapshot);
            assert.equal(after.effects.active_hold, '80');
            assert.deepEqual(after.wallet, { ...before.wallet, billing_reservations: '1' },
              'retain all 80 units without a charge/refund or new ledger pair');
          } else {
            assert.equal(facts.financial_status, 'not_applicable');
            assert.equal(facts.customer_price_version, null);
            assert.equal(facts.supplier_cost_version, null);
            assert.equal(facts.customer_snapshot_count, '0');
            assert.equal(facts.reservation_state, null);
            assert.equal(facts.reservation_amount, null);
            assert.equal(facts.reservation_currency, null);
            assert.equal(facts.reservation_snapshot, null);
            assert.equal(facts.hold_snapshot, null);
            assert.equal(facts.hold_amount, null);
            assert.equal(after.effects.active_hold, '0');
            assert.deepEqual(after.wallet, before.wallet, 'BYOK uncertainty must create no token wallet or financial effect');
          }

          const replayCheckpoint = dispatchCompletions.checkpoint();
          const replay = await postInference(scope.key.secret, idempotencyKey, body);
          const replayText = await replay.text();
          dispatchCompletions.assertNoDispatchSince(replayCheckpoint);
          assert.equal(replay.status, 202);
          assert.equal(replay.headers.get('x-canonical-request-id'), requestId);
          assert.deepEqual(JSON.parse(replayText),
            { object: 'request_status', id: requestId, status: 'unknown', response_replayed: false });
          assert.equal(upstreamCallCount, callsBefore + 1, 'unknown replay must never redispatch');
          assert.equal(network.snapshot().receipts, 1);
          assert.deepEqual(network.snapshot(), wire, 'unknown replay must not reopen or advance the invalid-usage upstream');
          assert.deepEqual(await readFinancialFaultFacts(scope, requestId), facts);
          assert.deepEqual(await gatewayEffectSnapshot(observationDatabase, scope.context.tenantId), after,
            'unknown replay must preserve hold, capacity, idempotency, usage, lease, health and all ledger facts');
          completedInvalidJsonUsageScenes += 1;
        }));
    }
    assert.equal(invalidJsonUsageNonces.size, 16, 'all invalid-usage HTTP scenes need distinct registered nonces');
    assert.equal(completedInvalidJsonUsageScenes, 16, 'all eight variants in both modes must reach every financial assertion');
  } catch (error) {
    dispatchCompletions.notePrimaryFailure();
    throw error;
  } finally {
    await dispatchCompletions.finalize(async () => {
      try {
        const closeTasks: Promise<unknown>[] = [];
        if (gatewayRuntime) closeTasks.push(gatewayRuntime.close());
        if (controlPlaneRuntime) closeTasks.push(controlPlaneRuntime.close());
        const faultCleanup = financialFaults.dispose().then(() => true, () => false);
        const ownedUpstream = upstream;
        if (ownedUpstream) closeTasks.push(faultCleanup.then(() => closeHttpServer(ownedUpstream)));
        if (seedDatabase) closeTasks.push(seedDatabase.close());
        if (controlPlaneProbe) closeTasks.push(controlPlaneProbe.close());
        if (gatewayProbe) closeTasks.push(gatewayProbe.close());
        await Promise.allSettled(closeTasks);
        if (!await faultCleanup) throw new Error('financial fault fixture cleanup failed');
        if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
    }, (diagnostic) => { t.diagnostic(`gateway_completion_cleanup ${JSON.stringify(diagnostic)}`); });
  }
});
