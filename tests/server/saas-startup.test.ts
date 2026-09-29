import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL } from '../../src/saas/db/credential-validation-worker-privileges.js';
import { SAAS_RUNTIME_PRIVILEGE_PROBE_SQL } from '../../src/saas/db/runtime-privileges.js';
import {
  DEPLOYMENT_ENV_VARS,
  type DeploymentEnvironment,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_URL,
  parseDeploymentConfig,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../../src/saas/deployment.js';
import type { createUnknownOutcomeRecoveryWorkflow } from '../../src/saas/metering/unknown-outcome-recovery-worker.js';
import type { PaymentProviderAdapter } from '../../src/saas/payments/adapter.js';
import { createSaasPaymentHandler, type SaasPaymentHttpOptions } from '../../src/saas/payments/http.js';
import type { PaymentOrderRecord, PaymentWebhookResult } from '../../src/saas/payments/types.js';
import type { ManagedSaasGatewayRuntimeDependencies } from '../../src/saas/runtime/gateway-runtime-module.js';
import type { ManagedSaasProviders } from '../../src/saas/runtime/providers.js';
import type { LoadedValidationWorkerProviderCredentialKms } from '../../src/saas/runtime/validation-worker-provider-credential-kms.js';
import { CustomerWebhookEgressTransport } from '../../src/saas/webhooks/egress-transport.js';
import type { WebhookSigningSecretProtector } from '../../src/saas/webhooks/signing-secret-protector.js';
import { startServer } from '../../src/server/index.js';
import {
  type ManagedSaasDatabase,
  type ManagedSaasRuntime,
  type ManagedSaasStartOptions,
  SAAS_PLATFORM_AUDIT_CURSOR_SECRET,
  startManagedSaasServer,
} from '../../src/server/managed-saas.js';

async function openServer(port = 0): Promise<{ server: Server; port: number }> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const reserved = await openServer();
  await closeServer(reserved.server);
  return reserved.port;
}

async function threeFreePorts(): Promise<{ customer: number; platform: number; gateway: number }> {
  return {
    customer: await freePort(),
    platform: await freePort(),
    gateway: await freePort(),
  };
}

const PLATFORM_AUDIT_CURSOR_SECRET = 'managed-platform-audit-cursor-secret-2026';
const PLATFORM_AUDIT_EVENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLATFORM_AUDIT_EVENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SAFE_RUNTIME_PRIVILEGE_ROW = {
  role_exists: true,
  server_version_supported: true,
  managed_schema: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_application_schema: false,
  owns_database_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  truncate_privilege: false,
  extra_table_privilege: false,
  missing_table_privilege_count: 0,
  out_of_schema_table_privilege: false,
  out_of_schema_sequence_privilege: false,
  out_of_schema_function_privilege: false,
  application_table_count: 22,
  missing_select_count: 0,
  missing_insert_count: 0,
  missing_update_count: 0,
  unsafe_delete_privilege: false,
  missing_sequence_privilege_count: 0,
  unexpected_sequence_privilege_count: 0,
  missing_spending_freeze_delete: false,
  missing_sequence_usage_count: 0,
  sequence_select_count: 0,
  sequence_update_count: 0,
  missing_function_execute_count: 0,
  unsafe_security_definer_function_count: 0,
};

function managedEnvironment(
  ports: { customer: number; platform: number; gateway: number },
  auditCursorSecret?: string,
): DeploymentEnvironment {
  return {
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: 'postgresql://saas-user:db-secret@db.example/saas',
    [DEPLOYMENT_ENV_VARS.saas.controlPlaneDatabaseUrl]: 'postgresql://control-plane:secret@db.example/saas',
    [DEPLOYMENT_ENV_VARS.saas.gatewayDatabaseUrl]: 'postgresql://gateway:secret@db.example/saas',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl]: 'postgresql://validation-worker:secret@db.example/saas',
    [MODEL_ROUTER_SAAS_REDIS_URL]: 'rediss://redis-user:redis-secret@redis.example:6380/0',
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: 'trusted-redis-provider',
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: 'trusted-kms-provider',
    [DEPLOYMENT_ENV_VARS.saas.providerCredentialSealingKmsModule]: 'trusted-provider-seal-kms',
    [DEPLOYMENT_ENV_VARS.saas.providerCredentialKmsKeyId]: 'kms/model-router/startup-test',
    [DEPLOYMENT_ENV_VARS.saas.deploymentId]: 'model-router-startup-test',
    [DEPLOYMENT_ENV_VARS.saas.environmentId]: 'test',
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: String(ports.customer),
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: `http://127.0.0.1:${ports.customer}`,
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: String(ports.platform),
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: `http://127.0.0.1:${ports.platform}`,
    [DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress]: '127.0.0.1',
    [DEPLOYMENT_ENV_VARS.listeners.gateway.port]: String(ports.gateway),
    [DEPLOYMENT_ENV_VARS.listeners.gateway.origin]: `http://127.0.0.1:${ports.gateway}`,
    ...(auditCursorSecret === undefined ? {} : { [SAAS_PLATFORM_AUDIT_CURSOR_SECRET]: auditCursorSecret }),
  };
}

function gatewayEnvironment(ports: { customer: number; platform: number; gateway: number }): DeploymentEnvironment {
  return {
    ...managedEnvironment(ports),
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'gateway',
    [MODEL_ROUTER_SAAS_DATABASE_URL]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.controlPlaneDatabaseUrl]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_URL]: undefined,
    [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: undefined,
    [MODEL_ROUTER_SAAS_KMS_PROVIDER]: undefined,
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.providerCredentialKmsKeyId]: undefined,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: undefined,
    [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: 'trusted-gateway-kms',
    [MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]: 'trusted-gateway-runtime',
    [DEPLOYMENT_ENV_VARS.listeners.customer.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.customer.origin]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.bindAddress]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.port]: undefined,
    [DEPLOYMENT_ENV_VARS.listeners.platform.origin]: undefined,
  };
}

function gatewayRuntimeDependencies(): ManagedSaasGatewayRuntimeDependencies {
  const verifierKeyId = 'gateway-verifier-test';
  return {
    entitlementResolver: {
      resolve: async () => ({
        decision: 'block',
        code: 'capability_unavailable',
        message: 'not invoked in startup test',
      }),
    },
    schedulerAuthorities: {
      affinityKeyring: {
        activeKeyVersion: 'test-v1',
        keys: [{ version: 'test-v1', key: new Uint8Array(32).fill(9) }],
      },
      leaseConcurrencyLimit: 4,
    },
    idempotencyHmacKey: new Uint8Array(32).fill(7),
    providerPreparationRoute: async () => ({}) as never,
    providerPayload: {
      estimator: { version: 'test-estimator', estimate: async () => ({}) },
      modelCompatibility: () => true,
      maxPayloadBytes: 1024 * 1024,
      compilerVersion: 'test-compiler',
    },
    evidenceSigner: { verifierKeyId, sign: async () => new Uint8Array([1]) } as never,
    evidenceVerifierKeyId: verifierKeyId,
    idFactory: { requestId: () => 'request', attemptId: () => 'attempt', evidenceId: () => 'evidence' },
    trustedVerifierPublicKeys: { [verifierKeyId]: new Uint8Array([1]) },
    providerTargetResolver: { resolve: () => ({}) } as never,
    providerTargetRoute: async () => null,
    resolveAuthenticationHeader: async () => ({}) as never,
    fetch: async () => new Response(),
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    timeoutMs: 10_000,
    maxConcurrency: 4,
    leaseTtlMs: 30_000,
    maxBodyBytes: 1024 * 1024,
    entryPoint: 'managed_gateway',
  } as unknown as ManagedSaasGatewayRuntimeDependencies;
}

function fakeGatewayRuntimeModule(
  events: string[],
  dependencies = gatewayRuntimeDependencies(),
  hooks: { checkReady?: () => Promise<void>; close?: () => Promise<void> } = {},
) {
  return {
    createManagedSaasGatewayRuntime: async (options: {
      deployment: { workloadRole: string; deploymentId: string; environmentId: string };
      env: DeploymentEnvironment;
    }) => {
      events.push('gateway-runtime-load');
      assert.equal(options.deployment.workloadRole, 'gateway');
      assert.equal(options.deployment.deploymentId, 'model-router-startup-test');
      assert.equal(options.deployment.environmentId, 'test');
      assert.equal(options.env[MODEL_ROUTER_SAAS_REDIS_URL], undefined);
      assert.equal(options.env[SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE], undefined);
      return {
        dependencies,
        checkReady: hooks.checkReady ?? (async () => events.push('gateway-runtime-ready')),
        close: hooks.close ?? (async () => events.push('gateway-runtime-close')),
      };
    },
  };
}

function fakeGatewayKmsModule(events: string[], checkReady = async () => events.push('gateway-kms-ready')) {
  return {
    createGatewayProviderCredentialUnsealingKms: async () => ({
      decryptDataKey: async () => new Uint8Array(32),
      checkReady,
      close: async () => events.push('gateway-kms-close'),
    }),
  };
}

function fakeDatabase(
  events: string[],
  runtimePrivilegeRow: Record<string, unknown> = SAFE_RUNTIME_PRIVILEGE_ROW,
): ManagedSaasDatabase {
  return {
    query: async <Row>(sql: string) => {
      if (sql === SAAS_RUNTIME_PRIVILEGE_PROBE_SQL) {
        events.push('runtime-privileges-verify');
        return { rows: [runtimePrivilegeRow as Row], rowCount: 1 };
      }
      if (sql === SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL) {
        events.push('validation-worker-runtime-privileges-verify');
        return {
          rows: [
            {
              role_exists: true,
              server_version_supported: true,
              managed_schema: true,
              login_role: true,
              session_role_unchanged: true,
              superuser: false,
              create_database: false,
              create_role: false,
              replication_role: false,
              bypass_rls: false,
              any_role_membership: false,
              owns_database: false,
              owns_schema: false,
              owns_objects: false,
              schema_create: false,
              database_create: false,
              database_temp: false,
              no_database_connect: false,
              any_table_level_privilege: false,
              missing_column_privilege: false,
              extra_column_privilege: false,
              any_sequence_privilege: false,
              any_function_privilege: false,
              out_of_schema_object_privilege: false,
            } as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    transaction: async () => {
      throw new Error('transaction not expected during startup tests');
    },
    migrate: async () => {
      events.push('migrate');
    },
    ping: async () => {
      events.push('database-ping-method');
    },
    close: async () => {
      events.push('database-close-method');
    },
    verifySchema: async () => {
      events.push('schema-method');
    },
  } as unknown as ManagedSaasDatabase;
}

function platformReadDatabase(roles: () => readonly string[], sqlStatements: string[]): ManagedSaasDatabase {
  const query = async <Row>(sql: string): Promise<{ rows: Row[]; rowCount: number }> => {
    sqlStatements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('FROM saas_audit_events AS a')) {
      const rows = [
        {
          id: PLATFORM_AUDIT_EVENT_A,
          tenant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          actor_user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          action: 'api_key.created',
          target_type: 'saas_api_key',
          target_id: 'key-reference-a',
          occurred_at: '2026-09-27T12:00:00.000Z',
          entry_point: 'platform_admin',
          request_id: 'audit-request-a',
          details: { password: 'must-not-leak' },
          source_ip: '192.0.2.1',
        },
        {
          id: PLATFORM_AUDIT_EVENT_B,
          tenant_id: null,
          actor_user_id: null,
          action: 'api_key.created',
          target_type: 'saas_api_key',
          target_id: 'provider-reference-b',
          occurred_at: '2026-09-26T12:00:00.000Z',
          entry_point: 'platform_admin',
          request_id: null,
        },
      ];
      return {
        rows: (sql.includes('(a.occurred_at, a.id) <') ? rows.slice(1) : rows) as Row[],
        rowCount: sql.includes('(a.occurred_at, a.id) <') ? 1 : 2,
      };
    }
    if (sql.includes('SELECT user_id') && sql.includes('FROM saas_platform_sessions')) {
      return { rows: [{ user_id: 'platform-user-1' } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT s.id, s.user_id, s.created_at, s.expires_at')) {
      return {
        rows: [
          {
            id: 'platform-session-1',
            user_id: 'platform-user-1',
            created_at: '2026-09-28T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT s.csrf_token_hash') && sql.includes('FROM saas_platform_sessions s')) {
      return { rows: [{ csrf_token_hash: sha256(MANAGED_TEST_CSRF_TOKEN) } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT role')) {
      return { rows: roles().map((role) => ({ role }) as Row), rowCount: roles().length };
    }
    if (sql.includes('FROM saas_requests AS r')) {
      return {
        rows: [
          {
            request_count: '2',
            request_pending_count: '0',
            request_succeeded_count: '2',
            request_failed_count: '0',
            request_unknown_count: '0',
            request_financial_not_applicable_count: '2',
            request_financial_pending_count: '0',
            request_financial_settled_count: '0',
            request_financial_released_count: '0',
            request_financial_reconciliation_pending_count: '0',
            attempt_count: '2',
            attempt_pending_count: '0',
            attempt_succeeded_count: '2',
            attempt_failed_count: '0',
            attempt_unknown_count: '0',
            attempt_http_4xx_count: '0',
            attempt_http_5xx_count: '0',
            response_start_latency_sample_count: '0',
            response_start_latency_p50_ms: null,
            response_start_latency_p95_ms: null,
            active_provider_account_lease_count: '1',
            billing_reservation_reserved_count: '0',
            billing_reservation_reconciliation_pending_count: '0',
            account_health_observation_count: '0',
            account_health_healthy_count: '0',
            account_health_degraded_count: '0',
            account_health_cooldown_count: '0',
            account_health_unhealthy_count: '0',
            account_health_active_cooldown_count: '0',
            account_health_latest_observed_at: null,
            webhook_pending_count: '0',
            webhook_processing_count: '0',
            webhook_oldest_unprocessed_age_ms: null,
            snapshot_at: '2026-09-28T00:00:00.000Z',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>): Promise<T> => work({ query }),
    migrate: async () => {},
    ping: async () => {},
    close: async () => {},
    verifySchema: async () => {},
  } as unknown as ManagedSaasDatabase;
}

const STARTUP_UNKNOWN_OUTCOME_TENANT = 'tenant-unknown-outcome-startup';
const STARTUP_UNKNOWN_OUTCOME_CASE = {
  caseId: 'case-unknown-outcome-startup',
  tenantId: STARTUP_UNKNOWN_OUTCOME_TENANT,
  projectId: 'project-unknown-outcome-startup',
  requestId: 'request-unknown-outcome-startup',
  supplyMode: 'platform' as const,
  scanAttempts: 1,
  lastErrorCode: null,
  createdAt: '2026-09-28T00:00:00.000Z',
};

function platformOperatorDatabase(roles: () => readonly string[], sqlStatements: string[]): ManagedSaasDatabase {
  const query = async <Row>(sql: string): Promise<{ rows: Row[]; rowCount: number }> => {
    sqlStatements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('SELECT user_id') && sql.includes('FROM saas_platform_sessions')) {
      return { rows: [{ user_id: 'platform-operator-startup' } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT s.id, s.user_id, s.created_at, s.expires_at')) {
      return {
        rows: [
          {
            id: 'platform-session-startup',
            user_id: 'platform-operator-startup',
            created_at: '2026-09-28T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT role')) {
      return { rows: roles().map((role) => ({ role }) as Row), rowCount: roles().length };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>): Promise<T> => work({ query }),
    migrate: async () => {},
    ping: async () => {},
    close: async () => {},
    verifySchema: async () => {},
  } as unknown as ManagedSaasDatabase;
}

function startupUnknownOutcomeWorkflow(events: string[]): ReturnType<typeof createUnknownOutcomeRecoveryWorkflow> {
  return {
    worker: {
      runOnce: async () => {
        events.push('unknown-outcome-run');
        return { claimed: 0, operatorRequired: [], superseded: [], leaseLost: [], deferred: [], failed: 0 };
      },
    },
    operatorResolution: {
      list: async (tenantId: string, limit: number) => {
        events.push(`unknown-outcome-list:${tenantId}:${limit}`);
        return tenantId === STARTUP_UNKNOWN_OUTCOME_TENANT ? [STARTUP_UNKNOWN_OUTCOME_CASE] : [];
      },
      get: async (tenantId: string, caseId: string) => {
        events.push(`unknown-outcome-detail:${tenantId}:${caseId}`);
        return tenantId === STARTUP_UNKNOWN_OUTCOME_TENANT && caseId === STARTUP_UNKNOWN_OUTCOME_CASE.caseId
          ? { summary: STARTUP_UNKNOWN_OUTCOME_CASE, possibleAttemptIds: [], observations: [] }
          : null;
      },
      resolveNotExecuted: async () => ({ status: 'resolved', caseId: 'case', requestId: 'request' }),
    },
    repository: {},
    providerObservations: {},
  } as unknown as ReturnType<typeof createUnknownOutcomeRecoveryWorkflow>;
}

const MANAGED_TEST_SESSION_TOKEN = 'managed-session-token-123456';
const MANAGED_TEST_CSRF_TOKEN = 'managed-csrf-token-123456';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function customerKeyDatabase(events: string[], sqlStatements: string[] = []): ManagedSaasDatabase {
  const query = async <Row>(sql: string): Promise<{ rows: Row[]; rowCount: number }> => {
    sqlStatements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('SELECT s.user_id, s.expires_at, s.created_at')) {
      return {
        rows: [
          {
            user_id: 'user-1',
            expires_at: '2099-01-01T00:00:00.000Z',
            created_at: '2026-09-28T00:00:00.000Z',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT s.csrf_token_hash FROM saas_sessions s')) {
      return { rows: [{ csrf_token_hash: sha256(MANAGED_TEST_CSRF_TOKEN) } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT t.id AS tenant_id')) {
      return {
        rows: [
          {
            tenant_id: 'tenant-1',
            tenant_role: 'owner',
            project_role: 'owner',
            project_id: 'project-1',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT id, status FROM saas_tenants')) {
      return { rows: [{ id: 'tenant-1', status: 'active' } as Row], rowCount: 1 };
    }
    if (sql.includes('FROM saas_projects WHERE tenant_id = $1 AND id = $2')) {
      return {
        rows: [
          {
            tenant_id: 'tenant-1',
            id: 'project-1',
            inference_policy_version: 1,
            inference_policy_status: 'active',
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM saas_project_inference_policy_versions')) {
      return {
        rows: [{ tenant_id: 'tenant-1', project_id: 'project-1', version: 1, status: 'active' } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT id, disabled_at, anonymized_at FROM saas_users')) {
      return { rows: [{ id: 'user-1', disabled_at: null, anonymized_at: null } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT tenant_id, user_id, role, status, revoked_at FROM saas_memberships')) {
      return {
        rows: [{ tenant_id: 'tenant-1', user_id: 'user-1', role: 'owner', status: 'active', revoked_at: null } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT tenant_id, project_id, user_id, role, status, revoked_at FROM saas_project_memberships')) {
      return {
        rows: [
          {
            tenant_id: 'tenant-1',
            project_id: 'project-1',
            user_id: 'user-1',
            role: 'owner',
            status: 'active',
            revoked_at: null,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('e.tenant_id AS entitlement_tenant_id')) {
      return {
        rows: [
          {
            entitlement_id: 'entitlement-1',
            entitlement_tenant_id: 'tenant-1',
            entitlement_project_id: 'project-1',
            entitlement_status: 'active',
            entitlement_profile_id: 'profile-1',
            entitlement_supply_mode: 'platform',
            entitlement_model_scopes: ['model-a'],
            entitlement_authz_version: 1,
            entitlement_effective_at: '2026-09-27T00:00:00.000Z',
            entitlement_expires_at: null,
            entitlement_superseded_at: null,
            profile_id: 'profile-1',
            profile_tenant_id: 'tenant-1',
            profile_status: 'active',
            profile_supply_mode: 'platform',
            profile_model_scopes: ['model-a'],
            profile_authz_version: 1,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM saas_route_config_heads h')) {
      return {
        rows: [
          {
            rights_id: 'rights-1',
            version: 1,
            effective_at: '2026-09-27T00:00:00.000Z',
            expires_at: null,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT clock_timestamp() AS now')) {
      return { rows: [{ now: '2026-09-28T00:00:00.000Z' } as Row], rowCount: 1 };
    }
    if (sql.includes('SELECT e.id AS entitlement_id')) {
      return {
        rows: [
          {
            entitlement_id: 'entitlement-1',
            tenant_id: 'tenant-1',
            project_id: 'project-1',
            entitlement_status: 'active',
            entitlement_authz_version: 1,
            profile_id: 'profile-1',
            profile_status: 'active',
            supply_profile_authz_version: 1,
            supply_mode: 'platform',
            entitlement_model_scopes: ['model-a'],
            profile_model_scopes: ['model-a'],
            superseded_at: null,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO saas_api_keys')) {
      return {
        rows: [
          {
            id: 'key-project-service',
            tenant_id: 'tenant-1',
            project_id: 'project-1',
            principal_user_id: null,
            execution_principal_type: 'project_service',
            execution_principal_id: 'project-1',
            created_by_user_id: 'user-1',
            rotated_by_user_id: null,
            revoked_by_user_id: null,
            entitlement_id: 'entitlement-1',
            supply_profile_id: 'profile-1',
            supply_mode: 'platform',
            name: 'Managed project service key',
            prefix: 'mr_live_managed1',
            model_scopes: ['model-a'],
            status: 'active',
            created_at: '2026-09-28T00:00:00.000Z',
            expires_at: null,
            revoked_at: null,
            last_used_at: null,
            authz_version: 1,
            model_scope_version: 1,
            entitlement_authz_version: 1,
            supply_profile_authz_version: 1,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>): Promise<T> => work({ query }),
    migrate: async () => {
      events.push('migrate');
    },
    ping: async () => {
      events.push('database-ping-method');
    },
    close: async () => {
      events.push('database-close-method');
    },
    verifySchema: async () => {
      events.push('schema-method');
    },
  } as unknown as ManagedSaasDatabase;
}

function paymentOrderRow(): Record<string, unknown> {
  return {
    id: 'order-managed-explicit',
    tenant_id: 'tenant-1',
    order_type: 'wallet_topup',
    provider_key: 'test-psp',
    merchant_id: 'merchant-1',
    client_request_id: 'payment-client-explicit',
    local_order_ref: 'order-managed-explicit',
    funding_reference: 'order-managed-explicit',
    amount_minor_units: '125',
    currency: 'USD',
    state: 'pending',
    provider_order_id: 'provider-order-explicit',
    provider_attempts: 1,
    provider_failure_code: null,
    funding_transaction_id: null,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    paid_at: null,
    fulfilled_at: null,
  };
}

function paymentCompositionDatabase(events: string[], sqlStatements: string[] = []): ManagedSaasDatabase {
  const base = customerKeyDatabase(events, sqlStatements);
  const query = async <Row>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> => {
    if (sql.includes('FROM saas_payment_orders') && sql.includes('client_request_id')) {
      return { rows: [paymentOrderRow() as Row], rowCount: 1 };
    }
    return base.query<Row>(sql, values);
  };
  return {
    ...base,
    query,
    transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>): Promise<T> => work({ query }),
  } as unknown as ManagedSaasDatabase;
}

function paymentAdapter(webhookCalls: Array<{ merchantId: string; rawBody: Buffer }>): PaymentProviderAdapter {
  return {
    providerKey: 'test-psp',
    async createOrder(input) {
      return {
        providerOrderId: `provider-${input.localOrderId}`,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
      };
    },
    async verifyWebhook(input) {
      webhookCalls.push({ merchantId: input.merchantId, rawBody: input.rawBody });
      throw new Error('signature rejected in startup test');
    },
    normalizeEvent() {
      throw new Error('normalizeEvent must not run after webhook rejection');
    },
  };
}

function fakeProviders(events: string[]): ManagedSaasProviders {
  const customerAuthRateLimiter = {
    take: async () => {
      events.push('customer-auth-limiter');
    },
  };
  const platformAuthRateLimiter = {
    take: async () => {
      events.push('platform-auth-limiter');
    },
  };
  const credentialKeyProvider = {
    getCurrentKey: async () => new Uint8Array(32),
    getKey: async () => undefined,
    checkReady: async () => undefined,
    close: async () => undefined,
  };
  const providerCredentialSealingKms = {
    generateDataKey: async () => ({
      plaintextKey: new Uint8Array(32),
      ciphertextBlob: new Uint8Array([1, 2, 3]),
    }),
    checkReady: async () => undefined,
    close: async () => undefined,
  };
  return {
    credentialKeyProvider,
    providerCredentialSealingKms,
    platformAuthRateLimiter,
    customerAuthRateLimiter,
    close: async () => {
      events.push('providers-close');
    },
  } as unknown as ManagedSaasProviders;
}

function managedOptions(events: string[], overrides: Partial<ManagedSaasStartOptions> = {}): ManagedSaasStartOptions {
  const database = fakeDatabase(events);
  const providers = fakeProviders(events);
  return {
    createDatabase: () => {
      events.push('database-create');
      return database;
    },
    pingDatabase: async () => {
      events.push('database-ping');
    },
    verifySchema: async () => {
      events.push('schema-verify');
    },
    verifyUnknownOutcomeSchema: async () => {},
    closeDatabase: async () => {
      events.push('database-close');
    },
    loadProviders: async () => {
      events.push('providers-ready');
      return providers;
    },
    installSignalHandlers: false,
    ...overrides,
  };
}

function deploymentFrom(environment: DeploymentEnvironment) {
  const deployment = parseDeploymentConfig(environment);
  assert.equal(deployment.mode, 'managed-saas');
  if (deployment.mode !== 'managed-saas') throw new Error('expected managed-saas');
  return deployment;
}

function origin(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function runtimeListener(runtime: ManagedSaasRuntime, name: 'customer' | 'platform' | 'gateway'): Server {
  const listener = runtime.listeners[name];
  assert.ok(listener, `expected ${name} listener to be bound for this workload`);
  return listener;
}

function inertListener(): Server {
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen: (...args: unknown[]) => EventEmitter;
    closeAllConnections: () => void;
  };
  server.listening = false;
  server.listen = () => {
    server.emit('listening');
    return server;
  };
  server.closeAllConnections = () => {};
  return server as unknown as Server;
}

async function startCapturedGateway(): Promise<{
  handler: RequestListener;
  runtime: ManagedSaasRuntime;
}> {
  const handlers = new Map<string, RequestListener>();
  const runtime = await startManagedSaasServer(
    deploymentFrom(managedEnvironment({ customer: 45_121, platform: 45_122, gateway: 45_123 })),
    managedOptions([], {
      createListener: (name, handler) => {
        handlers.set(name, handler);
        return inertListener();
      },
    }),
  );
  const handler = handlers.get('gateway');
  assert.ok(handler);
  return { handler, runtime };
}

function makeGatewayRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): { request: IncomingMessage; resumed: { value: boolean } } {
  const resumed = { value: false };
  const request = {
    url,
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    resume() {
      resumed.value = true;
      return request;
    },
  };
  return { request: request as unknown as IncomingMessage, resumed };
}

interface GatewayResponseRecord {
  status: number | undefined;
  headers: Record<string, unknown>;
  body: string;
  headersSent: boolean;
  writableEnded: boolean;
}

function makeGatewayResponse(): { response: ServerResponse; record: GatewayResponseRecord } {
  const record: GatewayResponseRecord = {
    status: undefined,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
  };
  const response = {
    get headersSent() {
      return record.headersSent;
    },
    get writableEnded() {
      return record.writableEnded;
    },
    get destroyed() {
      return false;
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      record.status = status;
      record.headers = headers;
      record.headersSent = true;
      return response;
    },
    end(body?: unknown) {
      record.body =
        body === undefined ? '' : typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('utf8');
      record.writableEnded = true;
      return response;
    },
  };
  return { response: response as unknown as ServerResponse, record };
}

async function invokeGateway(
  handler: RequestListener,
  url: string,
): Promise<{
  request: { value: boolean };
  response: GatewayResponseRecord;
}> {
  const request = makeGatewayRequest(url);
  const response = makeGatewayResponse();
  handler(request.request, response.response);
  for (let attempt = 0; attempt < 4 && !response.record.writableEnded; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(response.record.writableEnded, true);
  return { request: request.resumed, response: response.record };
}

async function invokeManagedHandler(
  handler: RequestListener,
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<GatewayResponseRecord> {
  const request = makeGatewayRequest(url, { ...options, method: options.method ?? 'GET' });
  const response = makeGatewayResponse();
  handler(request.request, response.response);
  for (let attempt = 0; attempt < 4 && !response.record.writableEnded; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(response.record.writableEnded, true);
  return response.record;
}

test('deployment mode is resolved before any config-file read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-saas-startup-'));
  try {
    let databaseCreated = false;
    await assert.rejects(
      startServer(undefined, path.join(dir, 'missing', 'config.json'), {
        environment: { [MODEL_ROUTER_DEPLOYMENT_MODE]: 'not-a-mode' },
        managedSaas: {
          createDatabase: () => {
            databaseCreated = true;
            throw new Error('database must not be constructed');
          },
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_MODE');
        return true;
      },
    );
    assert.equal(databaseCreated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SaaS settings require an explicit managed deployment mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-saas-settings-'));
  try {
    await assert.rejects(
      startServer(undefined, path.join(dir, 'missing.json'), {
        environment: { [MODEL_ROUTER_SAAS_DATABASE_URL]: 'postgresql://secret-user:secret@db.example/saas' },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'SAAS_SETTINGS_REQUIRE_MANAGED_MODE');
        assert.equal(String(error).includes('secret@'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('managed startup verifies PG/schema and providers before binding, without migrating or reading local config', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const created = new Map<string, Server>();
  let runtime: ManagedSaasRuntime | undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-managed-no-local-'));
  const configPath = path.join(dir, 'no-such-directory', 'config.json');
  try {
    await startServer(undefined, configPath, {
      environment,
      managedSaas: managedOptions(events, {
        createListener: (name, handler) => {
          events.push(`listener:${name}`);
          const server = http.createServer(handler);
          created.set(name, server);
          return server;
        },
        onReady: (value) => {
          events.push('ready');
          runtime = value;
        },
      }),
    });
    assert.ok(runtime);
    assert.deepEqual(events.slice(0, 8), [
      'database-create',
      'database-ping',
      'schema-verify',
      'providers-ready',
      'listener:customer',
      'listener:platform',
      'listener:gateway',
      'ready',
    ]);
    assert.equal(events.includes('migrate'), false);
    assert.deepEqual([...created.keys()], ['customer', 'platform', 'gateway']);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(path.dirname(configPath)), false);
  } finally {
    await runtime?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(events.slice(-2), ['providers-close', 'database-close']);
});

test('control-plane unknown-outcome schema readiness fails closed before workflow, scanner, providers, or listeners', async () => {
  const events: string[] = [];
  const environment = {
    ...managedEnvironment({ customer: 45_149, platform: 45_150, gateway: 45_151 }),
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  } satisfies DeploymentEnvironment;
  let listenersCreated = 0;
  let workflowCreated = false;
  let scannerStarted = false;

  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        environment,
        verifyUnknownOutcomeSchema: async () => {
          events.push('unknown-outcome-schema-failed');
          throw new Error('current SaaS migration registry is incomplete: migration 051 is missing');
        },
        createUnknownOutcomeRecoveryWorkflow: () => {
          workflowCreated = true;
          throw new Error('recovery workflow must not be created before schema readiness');
        },
        startUnknownOutcomeScanner: () => {
          scannerStarted = true;
          throw new Error('scanner must not start before schema readiness');
        },
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    ),
    /unknown-outcome schema readiness failed/,
  );

  assert.deepEqual(events, [
    'database-create',
    'database-ping',
    'schema-verify',
    'unknown-outcome-schema-failed',
    'database-close',
  ]);
  assert.equal(workflowCreated, false);
  assert.equal(scannerStarted, false);
  assert.equal(listenersCreated, 0);
});

test('managed gateway remains fail-closed by default', async () => {
  const { handler, runtime } = await startCapturedGateway();
  try {
    const mounted = await invokeGateway(handler, '/v1/chat/completions');
    assert.equal(mounted.response.status, 503);
    assert.equal(JSON.parse(mounted.response.body).error?.code, 'GATEWAY_UNAVAILABLE');
    assert.equal(mounted.request.value, true);

    const outside = await invokeGateway(handler, '/v1ish');
    assert.equal(outside.response.status, 404);
    assert.equal(JSON.parse(outside.response.body).error?.code, 'NOT_FOUND');
  } finally {
    await runtime.close();
  }
});

test('control-plane workload binds only customer/platform listeners and does not compose the gateway', async () => {
  const handlers = new Map<string, RequestListener>();
  const sqlStatements: string[] = [];
  let runtime: ManagedSaasRuntime | undefined;
  const environment = {
    ...managedEnvironment({ customer: 45_120, platform: 45_121, gateway: 45_122 }),
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  } satisfies DeploymentEnvironment;

  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions([], {
        environment,
        loadValidationWorkerKms: async () => {
          assert.fail('control-plane workload must not load the validation-worker KMS adapter');
        },
        startCredentialValidationWorker: () => {
          assert.fail('control-plane workload must not start the credential-validation loop');
        },
        createDatabase: () => platformReadDatabase(() => ['superadmin'], sqlStatements),
        createListener: (name, handler) => {
          handlers.set(name, handler);
          return inertListener();
        },
      }),
    );

    assert.deepEqual([...handlers.keys()], ['customer', 'platform']);
    assert.equal(runtime.listeners.gateway, undefined);
    assert.equal(runtime.gateway, null);
    assert.ok(runtime.providers);
    const platformHandler = handlers.get('platform');
    assert.ok(platformHandler);
    assert.equal((await invokeManagedHandler(platformHandler, '/admin/api/v1/me')).status, 401);
  } finally {
    await runtime?.close();
  }
});

test('control-plane mounts tenant-scoped unknown-outcome reads and stops its scanner on close', async () => {
  const events: string[] = [];
  const sqlStatements: string[] = [];
  const handlers = new Map<string, RequestListener>();
  const environment = {
    ...managedEnvironment({ customer: 45_140, platform: 45_141, gateway: 45_142 }),
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  } satisfies DeploymentEnvironment;
  const workflow = startupUnknownOutcomeWorkflow(events);
  let database: ManagedSaasDatabase | undefined;
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions([], {
        environment,
        verifyUnknownOutcomeSchema: async () => events.push('unknown-outcome-schema-ready'),
        createDatabase: () => {
          database = platformOperatorDatabase(() => ['operations'], sqlStatements);
          return database;
        },
        createUnknownOutcomeRecoveryWorkflow: (input) => {
          assert.equal(input.database, database);
          assert.equal(input.worker?.batchSize, 3);
          return workflow;
        },
        unknownOutcomeScanner: { intervalMs: 500, batchSize: 3 },
        startUnknownOutcomeScanner: (worker, options) => {
          assert.equal(worker, workflow.worker);
          assert.equal(options.intervalMs, 500);
          assert.equal(typeof options.onError, 'function');
          assert.equal(typeof options.onOperatorRequired, 'function');
          assert.equal(typeof options.onFailed, 'function');
          events.push('unknown-outcome-start');
          return {
            stop: async () => {
              events.push('unknown-outcome-stop');
            },
          };
        },
        createListener: (name, handler) => {
          handlers.set(name, handler);
          return inertListener();
        },
      }),
    );

    assert.deepEqual([...handlers.keys()], ['customer', 'platform']);
    assert.ok(runtime.unknownOutcomeScanner);
    const platformHandler = handlers.get('platform');
    assert.ok(platformHandler);

    const unauthenticated = await invokeManagedHandler(
      platformHandler,
      `/admin/api/v1/ops/unknown-outcomes?tenantId=${STARTUP_UNKNOWN_OUTCOME_TENANT}`,
    );
    assert.equal(unauthenticated.status, 401);

    const headers = { cookie: `mr_platform_admin_session=${MANAGED_TEST_SESSION_TOKEN}` };
    const list = await invokeManagedHandler(
      platformHandler,
      `/admin/api/v1/ops/unknown-outcomes?tenantId=${STARTUP_UNKNOWN_OUTCOME_TENANT}&limit=10`,
      { headers },
    );
    assert.equal(list.status, 200);
    assert.deepEqual((JSON.parse(list.body) as { data?: unknown }).data, {
      items: [STARTUP_UNKNOWN_OUTCOME_CASE],
    });

    const detail = await invokeManagedHandler(
      platformHandler,
      `/admin/api/v1/ops/unknown-outcomes/${STARTUP_UNKNOWN_OUTCOME_CASE.caseId}?tenantId=${STARTUP_UNKNOWN_OUTCOME_TENANT}`,
      { headers },
    );
    assert.equal(detail.status, 200);
    assert.deepEqual((JSON.parse(detail.body) as { data?: unknown }).data, {
      summary: STARTUP_UNKNOWN_OUTCOME_CASE,
      possibleAttemptIds: [],
      observations: [],
    });
    assert.deepEqual(events.slice(0, 4), [
      'unknown-outcome-schema-ready',
      'unknown-outcome-start',
      `unknown-outcome-list:${STARTUP_UNKNOWN_OUTCOME_TENANT}:10`,
      `unknown-outcome-detail:${STARTUP_UNKNOWN_OUTCOME_TENANT}:${STARTUP_UNKNOWN_OUTCOME_CASE.caseId}`,
    ]);
  } finally {
    await runtime?.close();
  }
  assert.deepEqual(events, [
    'unknown-outcome-schema-ready',
    'unknown-outcome-start',
    `unknown-outcome-list:${STARTUP_UNKNOWN_OUTCOME_TENANT}:10`,
    `unknown-outcome-detail:${STARTUP_UNKNOWN_OUTCOME_TENANT}:${STARTUP_UNKNOWN_OUTCOME_CASE.caseId}`,
    'unknown-outcome-stop',
  ]);
  assert.equal(
    sqlStatements.some((sql) => sql.includes('saas_platform_sessions')),
    true,
  );
  assert.equal(
    sqlStatements.some((sql) => sql.includes('saas_platform_role_assignments')),
    true,
  );
});

test('control-plane scanner is stopped and awaited when startup fails after composition', async () => {
  const events: string[] = [];
  const environment = {
    ...managedEnvironment({ customer: 45_143, platform: 45_144, gateway: 45_145 }),
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  } satisfies DeploymentEnvironment;
  const workflow = startupUnknownOutcomeWorkflow(events);
  let releaseStop: (() => void) | undefined;
  let stopped = false;
  const stopComplete = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });

  const failure = startManagedSaasServer(
    deploymentFrom(environment),
    managedOptions([], {
      environment,
      createUnknownOutcomeRecoveryWorkflow: () => workflow,
      startUnknownOutcomeScanner: () => ({
        stop: async () => {
          events.push('unknown-outcome-stop');
          stopped = true;
          await stopComplete;
        },
      }),
      createListener: (name) => {
        events.push(`listener-create:${name}`);
        if (name === 'platform') throw new Error('platform listener construction failed');
        return inertListener();
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
  releaseStop?.();
  await assert.rejects(failure, /platform listener construction failed/);
  assert.deepEqual(events, ['listener-create:customer', 'listener-create:platform', 'unknown-outcome-stop']);
});

test('gateway workload does not compose unknown-outcome operator routes or scanner', async () => {
  const handlers = new Map<string, RequestListener>();
  const environment = gatewayEnvironment({ customer: 45_146, platform: 45_147, gateway: 45_148 });
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions([], {
        environment,
        verifyUnknownOutcomeSchema: async () => {
          assert.fail('gateway workload must not consult the unknown-outcome schema gate');
        },
        createUnknownOutcomeRecoveryWorkflow: () => {
          assert.fail('gateway workload must not create the unknown-outcome workflow');
        },
        startUnknownOutcomeScanner: () => {
          assert.fail('gateway workload must not start the unknown-outcome scanner');
        },
        gatewayRuntimeModuleImporter: async () => fakeGatewayRuntimeModule([]),
        gatewayProviderCredentialKmsImporter: async () => fakeGatewayKmsModule([]),
        createListener: (name, handler) => {
          handlers.set(name, handler);
          return inertListener();
        },
      }),
    );

    assert.equal(runtime.unknownOutcomeScanner, null);
    const gatewayHandler = handlers.get('gateway');
    assert.ok(gatewayHandler);
    assert.equal((await invokeManagedHandler(gatewayHandler, '/admin/api/v1/ops/unknown-outcomes')).status, 404);
    assert.equal(
      (
        await invokeManagedHandler(gatewayHandler, '/admin/api/v1/ops/unknown-outcomes/case/resolve-not-executed', {
          method: 'POST',
        })
      ).status,
      404,
    );
  } finally {
    await runtime?.close();
  }
});

test('configured provider credential sealing fails closed before bind when its KMS capability is missing', async () => {
  const events: string[] = [];
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  let listenersCreated = 0;

  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        environment,
        loadProviders: async () => ({
          ...fakeProviders(events),
          providerCredentialSealingKms: undefined,
        }),
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    ),
    /provider credential sealing KMS is unavailable/,
  );

  assert.equal(listenersCreated, 0);
  assert.equal(events.includes('database-close'), true);
});

test('standard startServer route composes gateway runtime and binds only the /v1 listener', async () => {
  const environment = gatewayEnvironment({ customer: 45_123, platform: 45_124, gateway: 45_125 });
  const events: string[] = [];
  const listeners = new Map<string, RequestListener>();
  let runtime: ManagedSaasRuntime | undefined;
  await startServer(undefined, '/unused/local-config.json', {
    environment,
    managedSaas: managedOptions(events, {
      environment,
      loadProviders: async () => {
        assert.fail('gateway workload must not load control-plane providers, Redis or TOTP KMS');
      },
      gatewayRuntimeModuleImporter: async (specifier) => {
        assert.equal(specifier, 'trusted-gateway-runtime');
        return fakeGatewayRuntimeModule(events);
      },
      gatewayProviderCredentialKmsImporter: async (specifier) => {
        assert.equal(specifier, 'trusted-gateway-kms');
        return fakeGatewayKmsModule(events);
      },
      createListener: (name, handler) => {
        events.push(`listener:${name}`);
        listeners.set(name, handler);
        return inertListener();
      },
      onReady: (value) => {
        runtime = value;
        events.push('ready');
      },
    }),
  });

  assert.ok(runtime);
  assert.equal(runtime.providers, null);
  assert.ok(runtime.gateway);
  assert.deepEqual([...listeners.keys()], ['gateway']);
  assert.deepEqual(Object.keys(runtime.listeners), ['gateway']);
  const handler = listeners.get('gateway');
  assert.ok(handler);
  const outsideGatewayMount = await invokeManagedHandler(handler, '/console/api/v1/me');
  assert.equal(outsideGatewayMount.status, 404);
  assert.ok(events.indexOf('gateway-kms-ready') < events.indexOf('gateway-runtime-ready'));
  assert.ok(events.indexOf('gateway-runtime-ready') < events.indexOf('listener:gateway'));
  await runtime.close();
  assert.ok(events.indexOf('gateway-kms-close') < events.indexOf('gateway-runtime-close'));
  assert.equal(events.at(-1), 'database-close');
});

test('validation worker starts only its dedicated loop, KMS and database without providers or listeners', async () => {
  const events: string[] = [];
  const environment = {
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    NODE_ENV: 'production',
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'credential-validation-worker',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl]: 'postgresql://validation-worker:db-secret@db.example/saas',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: 'trusted-worker-kms',
    [DEPLOYMENT_ENV_VARS.saas.deploymentId]: 'model-router-validation-test',
    [DEPLOYMENT_ENV_VARS.saas.environmentId]: 'test',
  } satisfies DeploymentEnvironment;
  const kms: LoadedValidationWorkerProviderCredentialKms = {
    decryptDataKey: async () => Buffer.alloc(32),
    checkReady: async () => {
      events.push('validation-kms-ready');
    },
    close: async () => {
      events.push('validation-kms-close');
    },
  };
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        environment,
        loadProviders: async () => {
          assert.fail('validation worker must not load control-plane providers');
        },
        loadValidationWorkerKms: async () => {
          events.push('validation-kms-load');
          return kms;
        },
        startCredentialValidationWorker: (database, loadedKms, options) => {
          assert.ok(database);
          assert.equal(loadedKms, kms);
          assert.equal(options.deployment, 'model-router-validation-test');
          assert.equal(options.environment, 'test');
          events.push('validation-loop-start');
          return {
            close: async () => {
              events.push('validation-loop-close');
            },
          };
        },
        createListener: () => {
          assert.fail('validation worker must not create listeners');
        },
      }),
    );

    assert.equal(runtime.providers, null);
    assert.equal(runtime.gateway, null);
    assert.equal(runtime.credentialValidationWorker !== null, true);
    assert.deepEqual(runtime.listeners, {});
    assert.equal(events.includes('validation-worker-runtime-privileges-verify'), true);
    assert.deepEqual(events.slice(-3), ['validation-kms-load', 'validation-kms-ready', 'validation-loop-start']);
  } finally {
    await runtime?.close();
  }
  assert.ok(events.indexOf('validation-loop-close') < events.indexOf('validation-kms-close'));
  assert.equal(events.includes('providers-ready'), false);
});

test('gateway module, KMS, readiness and dependency failures close acquired resources before binding', async () => {
  const scenarios: Array<{
    readonly name: string;
    readonly runtimeModule?: (events: string[]) => unknown;
    readonly runtimeImporter?: (events: string[]) => (specifier: string) => Promise<unknown>;
    readonly kmsImporter?: (events: string[]) => (specifier: string) => Promise<unknown>;
    readonly expected: RegExp;
    readonly expectedEvents: readonly string[];
  }> = [
    {
      name: 'module load',
      runtimeImporter: () => async () => {
        throw new Error('private import diagnostic');
      },
      kmsImporter: () => async () => fakeGatewayKmsModule([]),
      expected: /gateway runtime module could not be loaded/,
      expectedEvents: ['database-close'],
    },
    {
      name: 'module factory partial failure',
      runtimeImporter: (events) => async () => ({
        createManagedSaasGatewayRuntime: async (options: {
          lifecycle: { registerCloseHook(hook: () => unknown): void };
        }) => {
          options.lifecycle.registerCloseHook(async () => events.push('gateway-runtime-partial-close'));
          throw new Error('private factory diagnostic');
        },
      }),
      kmsImporter: () => async () => fakeGatewayKmsModule([]),
      expected: /gateway runtime setup failed/,
      expectedEvents: ['gateway-runtime-partial-close', 'database-close'],
    },
    {
      name: 'KMS load',
      runtimeModule: (events) => fakeGatewayRuntimeModule(events),
      kmsImporter: () => async () => {
        throw new Error('private KMS diagnostic');
      },
      expected: /Provider credential KMS module could not be loaded/,
      expectedEvents: ['gateway-runtime-close', 'database-close'],
    },
    {
      name: 'KMS readiness',
      runtimeModule: (events) => fakeGatewayRuntimeModule(events),
      kmsImporter: (events) => async () =>
        fakeGatewayKmsModule(events, async () => {
          throw new Error('private readiness diagnostic');
        }),
      expected: /Provider credential KMS readiness check failed/,
      expectedEvents: ['gateway-kms-close', 'gateway-runtime-close', 'database-close'],
    },
    {
      name: 'runtime readiness',
      runtimeModule: (events) =>
        fakeGatewayRuntimeModule(events, gatewayRuntimeDependencies(), {
          checkReady: async () => {
            throw new Error('private runtime diagnostic');
          },
        }),
      kmsImporter: (events) => async () => fakeGatewayKmsModule(events),
      expected: /gateway runtime readiness failed/,
      expectedEvents: ['gateway-kms-close', 'gateway-runtime-close', 'database-close'],
    },
    {
      name: 'missing affinity keyring',
      runtimeModule: (events) => {
        const dependencies = {
          ...gatewayRuntimeDependencies(),
          schedulerAuthorities: {
            affinityKeyring: undefined,
            leaseConcurrencyLimit: 4,
          },
        };
        return fakeGatewayRuntimeModule(events, dependencies as unknown as ManagedSaasGatewayRuntimeDependencies);
      },
      expected: /gateway runtime module contract is incomplete/,
      expectedEvents: ['gateway-runtime-close', 'database-close'],
    },
    {
      name: 'malformed affinity keyring',
      runtimeModule: (events) => {
        const dependencies = {
          ...gatewayRuntimeDependencies(),
          schedulerAuthorities: {
            affinityKeyring: {
              activeKeyVersion: 'missing-version',
              keys: [{ version: 'v1', key: new Uint8Array(8).fill(0x73) }],
            },
            leaseConcurrencyLimit: 4,
          },
        };
        return fakeGatewayRuntimeModule(events, dependencies as unknown as ManagedSaasGatewayRuntimeDependencies);
      },
      expected: /gateway runtime module contract is incomplete/,
      expectedEvents: ['gateway-runtime-close', 'database-close'],
    },
    {
      name: 'lease concurrency mismatch',
      runtimeModule: (events) => {
        const dependencies = {
          ...gatewayRuntimeDependencies(),
          schedulerAuthorities: {
            affinityKeyring: {
              activeKeyVersion: 'test-v1',
              keys: [{ version: 'test-v1', key: new Uint8Array(32).fill(9) }],
            },
            leaseConcurrencyLimit: 3,
          },
        };
        return fakeGatewayRuntimeModule(events, dependencies as unknown as ManagedSaasGatewayRuntimeDependencies);
      },
      kmsImporter: (events) => async () => fakeGatewayKmsModule(events),
      expected: /scheduler and provider lease concurrency limits do not match/,
      expectedEvents: ['gateway-kms-close', 'gateway-runtime-close', 'database-close'],
    },
  ];

  for (const scenario of scenarios) {
    const environment = gatewayEnvironment({ customer: 45_126, platform: 45_127, gateway: 45_128 });
    const events: string[] = [];
    let listenersCreated = 0;
    await assert.rejects(
      startServer(undefined, '/unused/local-config.json', {
        environment,
        managedSaas: managedOptions(events, {
          environment,
          loadProviders: async () => {
            assert.fail('gateway workload must not load control-plane providers');
          },
          gatewayRuntimeModuleImporter:
            scenario.runtimeImporter?.(events) ??
            (async () => scenario.runtimeModule?.(events) ?? fakeGatewayRuntimeModule(events)),
          gatewayProviderCredentialKmsImporter:
            scenario.kmsImporter?.(events) ?? (async () => fakeGatewayKmsModule(events)),
          createListener: () => {
            listenersCreated += 1;
            return inertListener();
          },
        }),
      }),
      scenario.expected,
      scenario.name,
    );
    assert.equal(listenersCreated, 0, scenario.name);
    for (const event of scenario.expectedEvents) assert.ok(events.includes(event), `${scenario.name}: ${event}`);
  }
});

test('gateway runtime module cannot inject an HTTP handler or listener', async () => {
  const environment = gatewayEnvironment({ customer: 45_129, platform: 45_130, gateway: 45_131 });
  const events: string[] = [];
  let listenersCreated = 0;
  const dependencies = {
    ...gatewayRuntimeDependencies(),
    handler: () => undefined,
  } as unknown as ManagedSaasGatewayRuntimeDependencies;
  await assert.rejects(
    startServer(undefined, '/unused/local-config.json', {
      environment,
      managedSaas: managedOptions(events, {
        environment,
        gatewayRuntimeModuleImporter: async () => fakeGatewayRuntimeModule(events, dependencies),
        gatewayProviderCredentialKmsImporter: async () => fakeGatewayKmsModule(events),
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    }),
    /gateway runtime module contract is incomplete/,
  );
  assert.equal(listenersCreated, 0);
  assert.ok(events.includes('gateway-runtime-close'));
  assert.ok(events.includes('database-close'));
});

test('incomplete gateway configuration fails closed before any listener is mounted', async () => {
  const events: string[] = [];
  let listenersCreated = 0;
  const gateway = {
    providerCredentialUnsealingKms: {
      close: async () => {
        events.push('gateway-close');
      },
    },
  } as never;

  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(managedEnvironment({ customer: 45_124, platform: 45_125, gateway: 45_126 })),
      managedOptions(events, {
        gateway,
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    ),
    /gateway credential KMS readiness failed/,
  );
  assert.equal(listenersCreated, 0);
  assert.equal(events.includes('gateway-close'), true);
});

test('managed platform read routes use auth/RBAC without changing customer or gateway listeners', async () => {
  const roles = ['superadmin'] as const;
  const sqlStatements: string[] = [];
  const handlers = new Map<string, RequestListener>();
  let runtime: ManagedSaasRuntime | undefined;
  const environment = managedEnvironment(
    { customer: 45_131, platform: 45_132, gateway: 45_133 },
    PLATFORM_AUDIT_CURSOR_SECRET,
  );
  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions([], {
        environment,
        createDatabase: () => platformReadDatabase(() => roles, sqlStatements),
        createListener: (name, handler) => {
          handlers.set(name, handler);
          return inertListener();
        },
      }),
    );

    assert.deepEqual([...handlers.keys()], ['customer', 'platform', 'gateway']);
    const customerHandler = handlers.get('customer');
    const platformHandler = handlers.get('platform');
    const gatewayHandler = handlers.get('gateway');
    assert.ok(customerHandler);
    assert.ok(platformHandler);
    assert.ok(gatewayHandler);

    const unauthenticated = await invokeManagedHandler(platformHandler, '/admin/api/v1/me');
    assert.equal(unauthenticated.status, 401);
    assert.equal((JSON.parse(unauthenticated.body) as { error?: { code?: string } }).error?.code, 'UNAUTHENTICATED');

    const cookieHeaders = { cookie: `mr_platform_admin_session=${MANAGED_TEST_SESSION_TOKEN}` };
    const me = await invokeManagedHandler(platformHandler, '/admin/api/v1/me', { headers: cookieHeaders });
    assert.equal(me.status, 200);
    assert.deepEqual((JSON.parse(me.body) as { data?: unknown }).data, {
      userId: 'platform-user-1',
      roles: ['superadmin'],
    });

    const summary = await invokeManagedHandler(
      platformHandler,
      '/admin/api/v1/ops/summary?from=2026-09-27T00:00:00.000Z&to=2026-09-28T00:00:00.000Z',
      { headers: cookieHeaders },
    );
    assert.equal(summary.status, 200);
    assert.equal((JSON.parse(summary.body) as { data?: { requests?: { total?: string } } }).data?.requests?.total, '2');

    const supplyAccounts = await invokeManagedHandler(platformHandler, '/admin/api/v1/supply/accounts', {
      headers: cookieHeaders,
    });
    assert.equal(supplyAccounts.status, 200);
    assert.deepEqual((JSON.parse(supplyAccounts.body) as { data?: unknown }).data, { items: [] });
    const cacheControl = supplyAccounts.headers['cache-control'];
    assert.ok(typeof cacheControl === 'string');
    assert.match(cacheControl, /no-store/);

    const platformOrigin = environment[DEPLOYMENT_ENV_VARS.listeners.platform.origin];
    assert.ok(platformOrigin);
    const writeReadiness = await invokeManagedHandler(platformHandler, '/admin/api/v1/catalog/rights/versions', {
      method: 'POST',
      headers: {
        cookie: `mr_platform_admin_session=${MANAGED_TEST_SESSION_TOKEN}; mr_platform_admin_csrf=${MANAGED_TEST_CSRF_TOKEN}`,
        origin: platformOrigin,
        host: new URL(platformOrigin).host,
        'x-csrf-token': MANAGED_TEST_CSRF_TOKEN,
      },
    });
    assert.equal(writeReadiness.status, 415);
    assert.equal(
      (JSON.parse(writeReadiness.body) as { error?: { code?: string } }).error?.code,
      'JSON_REQUIRED',
      'write route should pass startup composition, auth, role, origin and CSRF before body validation',
    );

    for (const path of [
      '/admin/api/v1/catalog/products',
      '/admin/api/v1/catalog/capabilities?providerId=provider-a&limit=2',
      '/admin/api/v1/catalog/rights?providerId=provider-a&limit=2',
    ]) {
      const response = await invokeManagedHandler(platformHandler, path, { headers: cookieHeaders });
      assert.equal(response.status, 200, path);
      assert.deepEqual((JSON.parse(response.body) as { data?: unknown }).data, {
        items: [],
        hasMore: false,
        nextCursor: null,
      });
    }

    const audit = await invokeManagedHandler(
      platformHandler,
      `/admin/api/v1/audit/events?action=api_key.created&entityType=saas_api_key&createdFrom=2026-09-26T00:00:00.000Z&createdTo=2026-09-28T00:00:00.000Z&limit=1`,
      { headers: cookieHeaders },
    );
    assert.equal(audit.status, 200);
    const auditBody = JSON.parse(audit.body) as {
      data?: {
        items?: Array<Record<string, unknown>>;
        hasMore?: boolean;
        nextCursor?: string | null;
      };
    };
    assert.deepEqual(auditBody.data?.items, [
      {
        id: PLATFORM_AUDIT_EVENT_A,
        tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        actorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        action: 'api_key.created',
        entityType: 'saas_api_key',
        entityId: 'key-reference-a',
        occurredAt: '2026-09-27T12:00:00.000Z',
        entryPoint: 'platform_admin',
        requestId: 'audit-request-a',
      },
    ]);
    assert.equal(auditBody.data?.hasMore, true);
    assert.match(auditBody.data?.nextCursor ?? '', /^pah1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    assert.doesNotMatch(audit.body, /must-not-leak|source_ip|password/);

    const nextAudit = await invokeManagedHandler(
      platformHandler,
      `/admin/api/v1/audit/events?${new URLSearchParams({
        action: 'api_key.created',
        entityType: 'saas_api_key',
        createdFrom: '2026-09-26T00:00:00.000Z',
        createdTo: '2026-09-28T00:00:00.000Z',
        limit: '1',
        cursor: auditBody.data?.nextCursor ?? '',
      })}`,
      { headers: cookieHeaders },
    );
    assert.equal(nextAudit.status, 200);
    const nextAuditBody = JSON.parse(nextAudit.body) as {
      data?: { items?: Array<Record<string, unknown>>; hasMore?: boolean; nextCursor?: string | null };
    };
    assert.deepEqual(nextAuditBody.data?.items, [
      {
        id: PLATFORM_AUDIT_EVENT_B,
        tenantId: null,
        actorId: null,
        action: 'api_key.created',
        entityType: 'saas_api_key',
        entityId: 'provider-reference-b',
        occurredAt: '2026-09-26T12:00:00.000Z',
        entryPoint: 'platform_admin',
        requestId: null,
      },
    ]);
    assert.equal(nextAuditBody.data?.hasMore, false);
    assert.equal(nextAuditBody.data?.nextCursor, null);

    const unknown = await invokeManagedHandler(platformHandler, '/admin/api/v1/not-a-route', {
      headers: cookieHeaders,
    });
    assert.equal(unknown.status, 404);
    assert.equal((JSON.parse(unknown.body) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');

    const customer = await invokeManagedHandler(customerHandler, '/console/api/v1/not-a-route');
    assert.equal(customer.status, 404);
    const gateway = await invokeManagedHandler(gatewayHandler, '/v1/chat/completions', { method: 'POST' });
    assert.equal(gateway.status, 503);
    assert.equal((JSON.parse(gateway.body) as { error?: { code?: string } }).error?.code, 'GATEWAY_UNAVAILABLE');

    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_provider_products')),
      true,
    );
    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_provider_capabilities')),
      true,
    );
    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_provider_rights')),
      true,
    );
    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_platform_role_assignments')),
      true,
    );
    assert.equal(sqlStatements.filter((sql) => sql.includes('saas_audit_events')).length, 2);
    assert.equal(
      sqlStatements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)),
      true,
    );
  } finally {
    await runtime?.close();
  }
});

test('missing audit cursor secret preserves read APIs and leaves audit unavailable', async () => {
  let roles: readonly string[] = ['superadmin'];
  const sqlStatements: string[] = [];
  const handlers = new Map<string, RequestListener>();
  let runtime: ManagedSaasRuntime | undefined;
  const environment = managedEnvironment({ customer: 45_134, platform: 45_135, gateway: 45_136 });
  assert.equal(environment[SAAS_PLATFORM_AUDIT_CURSOR_SECRET], undefined);

  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions([], {
        environment,
        createDatabase: () => platformReadDatabase(() => roles, sqlStatements),
        createListener: (name, handler) => {
          handlers.set(name, handler);
          return inertListener();
        },
      }),
    );

    const platformHandler = handlers.get('platform');
    const gatewayHandler = handlers.get('gateway');
    assert.ok(platformHandler);
    assert.ok(gatewayHandler);

    const unauthenticated = await invokeManagedHandler(platformHandler, '/admin/api/v1/audit/events');
    assert.equal(unauthenticated.status, 401);
    assert.equal((JSON.parse(unauthenticated.body) as { error?: { code?: string } }).error?.code, 'UNAUTHENTICATED');

    const cookieHeaders = { cookie: `mr_platform_admin_session=${MANAGED_TEST_SESSION_TOKEN}` };
    const read = await invokeManagedHandler(platformHandler, '/admin/api/v1/me', { headers: cookieHeaders });
    assert.equal(read.status, 200);
    const summary = await invokeManagedHandler(
      platformHandler,
      '/admin/api/v1/ops/summary?from=2026-09-27T00:00:00.000Z&to=2026-09-28T00:00:00.000Z',
      { headers: cookieHeaders },
    );
    assert.equal(summary.status, 200);

    roles = ['finance'];
    const forbidden = await invokeManagedHandler(platformHandler, '/admin/api/v1/audit/events', {
      headers: cookieHeaders,
    });
    assert.equal(forbidden.status, 403);
    assert.equal((JSON.parse(forbidden.body) as { error?: { code?: string } }).error?.code, 'FORBIDDEN');
    roles = ['superadmin'];

    const unavailable = await invokeManagedHandler(platformHandler, '/admin/api/v1/audit/events', {
      headers: cookieHeaders,
    });
    assert.equal(unavailable.status, 503);
    assert.equal((JSON.parse(unavailable.body) as { error?: { code?: string } }).error?.code, 'AUDIT_UNAVAILABLE');
    assert.doesNotMatch(unavailable.body, /secret|password|database|provider/i);

    const unknown = await invokeManagedHandler(platformHandler, '/admin/api/v1/audit/unknown', {
      headers: cookieHeaders,
    });
    assert.equal(unknown.status, 404);
    assert.equal((JSON.parse(unknown.body) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');

    const gateway = await invokeManagedHandler(gatewayHandler, '/v1/chat/completions', { method: 'POST' });
    assert.equal(gateway.status, 503);
    assert.equal((JSON.parse(gateway.body) as { error?: { code?: string } }).error?.code, 'GATEWAY_UNAVAILABLE');

    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_audit_events')),
      false,
    );
    assert.equal(
      sqlStatements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)),
      true,
    );
  } finally {
    await runtime?.close();
  }
});

test('invalid audit cursor secret fails startup before constructing database or listeners', async () => {
  const invalidSecret = 'too-short';
  const environment = managedEnvironment({ customer: 45_137, platform: 45_138, gateway: 45_139 }, invalidSecret);
  const events: string[] = [];
  let listenersCreated = 0;

  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        environment,
        createDatabase: () => {
          events.push('database-created');
          return fakeDatabase(events);
        },
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    ),
    (error: unknown) => {
      assert.match(String(error), /cursor secret is invalid/i);
      assert.doesNotMatch(String(error), new RegExp(invalidSecret));
      return true;
    },
  );
  assert.deepEqual(events, []);
  assert.equal(listenersCreated, 0);
});

test('managed API ownership is isolated and the unfinished gateway fails closed', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-managed-web-'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><body>managed shell</body></html>');
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(deploymentFrom(environment), {
      ...managedOptions(events),
      webDistPath: web,
    });
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const platformOrigin = origin(runtimeListener(runtime, 'platform'));
    const gatewayOrigin = origin(runtimeListener(runtime, 'gateway'));

    const gateway = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const gatewayBody = (await gateway.json()) as { error?: { code?: string } };
    assert.equal(gateway.status, 503);
    assert.equal(gatewayBody.error?.code, 'GATEWAY_UNAVAILABLE');

    const gatewaySibling = await fetch(`${gatewayOrigin}/v1ish`);
    assert.equal(gatewaySibling.status, 404);

    for (const url of [
      `${customerOrigin}/console/api/v1/not-a-route`,
      `${customerOrigin}/console/api/not-a-route`,
      `${customerOrigin}/console/api%2Fv1/not-a-route`,
      `${platformOrigin}/admin/api/v1/not-a-route`,
      `${platformOrigin}/admin/api/not-a-route`,
      `${platformOrigin}/admin/api%2Fv1/not-a-route`,
    ]) {
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      const body = await response.text();
      assert.doesNotMatch(body, /managed shell/);
      assert.equal((JSON.parse(body) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');
    }

    for (const url of [
      `${customerOrigin}/console/%2e%2e/secret`,
      `${customerOrigin}/console/%252e%252e/%252e%252e/secret`,
      `${customerOrigin}/console/%252Fsecret`,
      `${platformOrigin}/admin/%2e%2e/secret`,
      `${platformOrigin}/admin/%252e%252e/%252e%252e/secret`,
    ]) {
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.doesNotMatch(await response.text(), /managed shell/);
    }

    for (const url of [`${customerOrigin}/console/%zz`, `${platformOrigin}/admin/%zz`]) {
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal((JSON.parse(await response.text()) as { error?: { code?: string } }).error?.code, 'INVALID_PATH');
    }

    assert.equal((await fetch(`${customerOrigin}/admin/`)).status, 404);
    assert.equal((await fetch(`${platformOrigin}/console/`)).status, 404);
  } finally {
    await runtime?.close();
    fs.rmSync(web, { recursive: true, force: true });
  }
});

test('managed customer and platform auth handlers use their injected rate limiters', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(deploymentFrom(environment), managedOptions(events));
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const platformOrigin = origin(runtimeListener(runtime, 'platform'));

    const customerResponse = await fetch(`${customerOrigin}/console/api/v1/auth/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: customerOrigin,
      },
      body: JSON.stringify({ email: 'missing@example.com', password: 'not-a-real-password' }),
    });
    assert.equal(customerResponse.status, 401);
    assert.match(customerResponse.headers.get('content-type') ?? '', /^application\/json/);

    const platformResponse = await fetch(`${platformOrigin}/admin/api/v1/auth/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: platformOrigin,
      },
      body: JSON.stringify({ email: 'missing@example.com', password: 'not-a-real-password', code: '000000' }),
    });
    assert.equal(platformResponse.status, 401);
    assert.match(platformResponse.headers.get('content-type') ?? '', /^application\/json/);

    assert.equal(events.filter((event) => event === 'customer-auth-limiter').length, 2);
    assert.equal(events.filter((event) => event === 'platform-auth-limiter').length, 2);
  } finally {
    await runtime?.close();
  }
});

test('managed customer routes project-service key creation through the key handler and preserves identity routes', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const sqlStatements: string[] = [];
  let runtime: ManagedSaasRuntime | undefined;
  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, { createDatabase: () => customerKeyDatabase(events, sqlStatements) }),
    );
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const platformOrigin = origin(runtimeListener(runtime, 'platform'));
    const headers = {
      cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}; mr_saas_csrf=${MANAGED_TEST_CSRF_TOKEN}`,
      origin: customerOrigin,
      'x-csrf-token': MANAGED_TEST_CSRF_TOKEN,
      'content-type': 'application/json',
    };
    const keyPath = '/console/api/v1/tenants/tenant-1/projects/project-1/keys';

    const created = await fetch(`${customerOrigin}${keyPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Managed project service key',
        modelScopes: ['model-a'],
        supplyMode: 'platform',
        principalKind: 'project_service',
      }),
    });
    const createdText = await created.text();
    assert.equal(
      created.status,
      201,
      `status=${created.status} body=${createdText} sql=${JSON.stringify(sqlStatements)}`,
    );
    const createdBody = JSON.parse(createdText) as { data?: Record<string, unknown> };
    assert.equal(createdBody.data?.executionPrincipalType, 'project_service');
    assert.equal(createdBody.data?.executionPrincipalId, 'project-1');
    assert.equal(createdBody.data?.principalUserId, null);
    assert.equal(createdBody.data?.prefix, 'mr_live_managed1');
    assert.equal(
      sqlStatements.some((sql) => sql.startsWith('INSERT INTO saas_api_keys')),
      true,
    );
    assert.equal(
      sqlStatements.some((sql) => sql.startsWith('INSERT INTO saas_audit_events')),
      true,
    );

    const identity = await fetch(`${customerOrigin}/console/api/v1/auth/session`, {
      headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` },
    });
    assert.equal(identity.status, 200);
    const identityBody = (await identity.json()) as { data?: { session?: { userId?: string } } };
    assert.equal(identityBody.data?.session?.userId, 'user-1');

    const usage = await fetch(
      `${customerOrigin}/console/api/v1/tenants/tenant-1/usage?from=2026-09-27T00:00:00.000Z&to=2026-09-28T00:00:00.000Z`,
      { headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` } },
    );
    assert.equal(usage.status, 200);
    const usageBody = (await usage.json()) as { data?: unknown; meta?: { requestId?: string } };
    assert.equal(usageBody.data, null);
    assert.match(usageBody.meta?.requestId ?? '', /^saas_console_/);

    const catalog = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/service-plans/catalog`, {
      headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` },
    });
    assert.equal(catalog.status, 200);
    const catalogBody = (await catalog.json()) as { data?: unknown; meta?: { requestId?: string } };
    assert.deepEqual(catalogBody.data, []);
    assert.match(catalogBody.meta?.requestId ?? '', /^saas_plan_/);
    assert.equal(
      sqlStatements.some((sql) => sql.includes('saas_service_plan_versions')),
      true,
    );

    const forgedKind = await fetch(`${customerOrigin}${keyPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Forged key',
        modelScopes: ['model-a'],
        supplyMode: 'platform',
        principalKind: 'platform_admin',
      }),
    });
    assert.equal(forgedKind.status, 400);

    const platformKey = await fetch(`${platformOrigin}/admin/api/v1/tenants/tenant-1/projects/project-1/keys`, {
      headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` },
    });
    assert.equal(platformKey.status, 404);
  } finally {
    await runtime?.close();
  }
});

test('managed customer and platform compositions mount explicitly configured payment and refund routes', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const sqlStatements: string[] = [];
  const webhookCalls: Array<{ merchantId: string; rawBody: Buffer }> = [];
  let runtime: ManagedSaasRuntime | undefined;

  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        createDatabase: () => paymentCompositionDatabase(events, sqlStatements),
        payments: {
          adapter: paymentAdapter(webhookCalls),
          refundAdapter: {
            providerKey: 'test-psp',
            merchantId: 'merchant-1',
            async submitRefund(input) {
              return { ...input, providerRefundId: 'fake-refund-1', status: 'succeeded' };
            },
            async queryRefund(input) {
              return { ...input, providerRefundId: input.providerRefundId, status: 'not_found' };
            },
          },
          providerKey: 'test-psp',
          merchantId: 'merchant-1',
          walletTopUpPolicy: {
            currency: 'USD',
            minAmountMinorUnits: '100',
            maxAmountMinorUnits: '100000',
          },
        },
      }),
    );
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const platformOrigin = origin(runtimeListener(runtime, 'platform'));
    const refundRoute = await fetch(
      `${platformOrigin}/admin/api/v1/payments/refunds/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002`,
    );
    assert.equal(refundRoute.status, 401, 'explicit refund configuration mounts the authenticated platform route');
    const sessionHeaders = { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` };
    const paymentHeaders = {
      cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}; mr_saas_csrf=${MANAGED_TEST_CSRF_TOKEN}`,
      origin: customerOrigin,
      'x-csrf-token': MANAGED_TEST_CSRF_TOKEN,
      'content-type': 'application/json',
      'idempotency-key': 'payment-client-explicit',
    };

    const order = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/orders`, {
      method: 'POST',
      headers: paymentHeaders,
      body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
    });
    assert.equal(order.status, 201);
    const orderBody = (await order.json()) as { data?: Record<string, unknown> };
    assert.equal(orderBody.data?.id, 'order-managed-explicit');
    assert.equal(orderBody.data?.orderType, 'wallet_topup');
    assert.equal(Object.hasOwn(orderBody.data ?? {}, 'providerKey'), false);
    assert.equal(Object.hasOwn(orderBody.data ?? {}, 'merchantId'), false);

    const catalog = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/service-plans/catalog`, {
      headers: sessionHeaders,
    });
    assert.equal(catalog.status, 200);

    const unauthenticated = await fetch(
      `${customerOrigin}/console/api/v1/tenants/tenant-1/orders/order-managed-explicit`,
    );
    assert.equal(unauthenticated.status, 401);

    const csrfRejected = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/orders`, {
      method: 'POST',
      headers: {
        cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'payment-client-explicit',
      },
      body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
    });
    assert.equal(csrfRejected.status, 403);

    const webhook = await fetch(`${customerOrigin}/payments/webhooks/test-psp`, {
      method: 'POST',
      body: 'provider-body',
    });
    assert.equal(webhook.status, 400);
    assert.equal((JSON.parse(await webhook.text()) as { error?: { code?: string } }).error?.code, 'WEBHOOK_REJECTED');
    assert.deepEqual(webhookCalls, [{ merchantId: 'merchant-1', rawBody: Buffer.from('provider-body') }]);
  } finally {
    await runtime?.close();
  }
});

test('managed startup leaves payment routes fail-closed when payments are absent', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const sqlStatements: string[] = [];
  let runtime: ManagedSaasRuntime | undefined;

  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, { createDatabase: () => customerKeyDatabase(events, sqlStatements) }),
    );
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const webhook = await fetch(`${customerOrigin}/payments/webhooks/test-psp`, {
      method: 'POST',
      body: 'provider-body',
    });
    assert.equal(webhook.status, 404);
    assert.equal((JSON.parse(await webhook.text()) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');

    const order = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/orders`, {
      method: 'POST',
      headers: {
        cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}; mr_saas_csrf=${MANAGED_TEST_CSRF_TOKEN}`,
        origin: customerOrigin,
        'x-csrf-token': MANAGED_TEST_CSRF_TOKEN,
        'content-type': 'application/json',
        'idempotency-key': 'payment-client-absent',
      },
      body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
    });
    assert.equal(order.status, 404);
    assert.equal((JSON.parse(await order.text()) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');

    const refundHistory = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/refunds`, {
      headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` },
    });
    assert.equal(refundHistory.status, 200);
    assert.deepEqual((JSON.parse(await refundHistory.text()) as { data?: unknown }).data, {
      items: [],
      nextCursor: null,
    });
    const refundAuthorizationQueries = sqlStatements.filter(
      (sql) => sql.includes('FROM saas_tenants t') && sql.includes('m.role AS tenant_role'),
    );
    assert.equal(refundAuthorizationQueries.length, 2);
    for (const sql of refundAuthorizationQueries) {
      assert.doesNotMatch(sql, /saas_project_memberships|saas_projects/);
    }

    const refundSelectCount = sqlStatements.filter((sql) => sql.includes('FROM saas_refund_orders')).length;
    const deniedRefundHistory = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-other/refunds`, {
      headers: { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` },
    });
    assert.equal(deniedRefundHistory.status, 403);
    assert.equal(sqlStatements.filter((sql) => sql.includes('FROM saas_refund_orders')).length, refundSelectCount);

    const platformOrigin = origin(runtimeListener(runtime, 'platform'));
    const refunds = await fetch(
      `${platformOrigin}/admin/api/v1/payments/refunds/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002`,
    );
    assert.equal(refunds.status, 404);
    assert.equal((JSON.parse(await refunds.text()) as { error?: { code?: string } }).error?.code, 'NOT_FOUND');
  } finally {
    await runtime?.close();
  }
});

test('managed startup rejects ambiguous payment handler configuration before constructing resources', async () => {
  const events: string[] = [];
  let listenersCreated = 0;
  const paymentHandler = async () => true;

  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(managedEnvironment({ customer: 45_141, platform: 45_142, gateway: 45_143 })),
      managedOptions(events, {
        payments: {
          adapter: paymentAdapter([]),
          providerKey: 'test-psp',
          merchantId: 'merchant-1',
        },
        paymentHandler,
        createListener: () => {
          listenersCreated += 1;
          return inertListener();
        },
      }),
    ),
    /cannot both be configured/,
  );
  assert.deepEqual(events, []);
  assert.equal(listenersCreated, 0);
});

test('managed customer composition mounts injected payment routes and preserves identity/console fallthrough', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const sqlStatements: string[] = [];
  const paymentOrder: PaymentOrderRecord = {
    id: 'order-managed-1',
    tenantId: 'tenant-1',
    orderType: 'wallet_topup',
    providerKey: 'test-psp',
    merchantId: 'merchant-1',
    clientRequestId: 'payment-client-1',
    localOrderRef: 'order-managed-1',
    fundingReference: 'order-managed-1',
    amountMinorUnits: '125',
    currency: 'USD',
    status: 'pending',
    providerOrderId: null,
    providerAttempts: 0,
    providerFailureCode: null,
    fundingTransactionId: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    paidAt: null,
    fulfilledAt: null,
    checkout: {
      status: 'unavailable',
      action: null,
    },
  };
  let paymentInput: unknown;
  const paymentService = {
    providerKey: 'test-psp',
    createWalletTopUp: async (
      input: Parameters<NonNullable<SaasPaymentHttpOptions['paymentService']['createWalletTopUp']>>[0],
    ) => {
      paymentInput = input;
      return paymentOrder;
    },
    getWalletTopUp: async () => null,
    retryProviderOrder: async () => paymentOrder,
    handleWebhook: async (): Promise<PaymentWebhookResult> => ({
      outcome: 'accepted',
      replayed: false,
      inboxId: 'inbox-1',
      orderId: null,
      fundingTransactionId: null,
    }),
  } satisfies SaasPaymentHttpOptions['paymentService'];
  const paymentIdentity = {
    getSession: async (token: string) =>
      token === MANAGED_TEST_SESSION_TOKEN
        ? {
            userId: 'user-1',
            activeTenantId: null,
            expiresAt: '2099-01-01T00:00:00.000Z',
            createdAt: '2026-09-28T00:00:00.000Z',
          }
        : undefined,
    verifyCsrfToken: async (token: string, csrfToken: string) =>
      token === MANAGED_TEST_SESSION_TOKEN && csrfToken === MANAGED_TEST_CSRF_TOKEN,
    resolveTenantContext: async ({ userId, tenantId }: { userId: string; tenantId: string }) => ({
      userId,
      tenantId,
      projectId: 'project-1',
      tenantRole: 'owner' as const,
      projectRole: 'owner' as const,
    }),
  } satisfies SaasPaymentHttpOptions['service'];
  const paymentHandler = createSaasPaymentHandler({
    service: paymentIdentity,
    paymentService,
    walletTopUpPolicy: {
      currency: 'USD',
      minAmountMinorUnits: '100',
      maxAmountMinorUnits: '100000',
    },
    publicOrigin: `http://127.0.0.1:${ports.customer}`,
  });
  let runtime: ManagedSaasRuntime | undefined;

  try {
    runtime = await startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        createDatabase: () => customerKeyDatabase(events, sqlStatements),
        paymentHandler,
      }),
    );
    const customerOrigin = origin(runtimeListener(runtime, 'customer'));
    const sessionHeaders = { cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}` };
    const paymentHeaders = {
      cookie: `mr_saas_session=${MANAGED_TEST_SESSION_TOKEN}; mr_saas_csrf=${MANAGED_TEST_CSRF_TOKEN}`,
      origin: customerOrigin,
      'x-csrf-token': MANAGED_TEST_CSRF_TOKEN,
      'content-type': 'application/json',
      'idempotency-key': 'payment-client-1',
    };

    const payment = await fetch(`${customerOrigin}/console/api/v1/tenants/tenant-1/orders`, {
      method: 'POST',
      headers: paymentHeaders,
      body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
    });
    assert.equal(payment.status, 201);
    assert.deepEqual(paymentInput, {
      tenantId: 'tenant-1',
      clientRequestId: 'payment-client-1',
      amountMinorUnits: '125',
      currency: 'USD',
    });
    assert.equal(((await payment.json()) as { data?: { id?: string } }).data?.id, 'order-managed-1');

    const identity = await fetch(`${customerOrigin}/console/api/v1/auth/session`, { headers: sessionHeaders });
    assert.equal(identity.status, 200);
    assert.equal(
      ((await identity.json()) as { data?: { session?: { userId?: string } } }).data?.session?.userId,
      'user-1',
    );

    const console = await fetch(
      `${customerOrigin}/console/api/v1/tenants/tenant-1/usage?from=2026-09-27T00:00:00.000Z&to=2026-09-28T00:00:00.000Z`,
      { headers: sessionHeaders },
    );
    assert.equal(console.status, 200);
    assert.equal(((await console.json()) as { data?: unknown }).data, null);
  } finally {
    await runtime?.close();
  }
});

test('schema readiness failure closes PG and prevents provider/listener construction', async () => {
  const environment = managedEnvironment({ customer: 45_101, platform: 45_102, gateway: 45_103 });
  const events: string[] = [];
  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        verifySchema: async () => {
          events.push('schema-failed');
          throw new Error('schema unavailable');
        },
      }),
    ),
    /schema verification failed/,
  );
  assert.deepEqual(events, ['database-create', 'database-ping', 'schema-failed', 'database-close']);
});

test('production startup checks effective DB privileges before loading providers or binding listeners', async () => {
  const ports = await threeFreePorts();
  const environment: DeploymentEnvironment = {
    ...managedEnvironment(ports),
    NODE_ENV: 'production',
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  };
  const events: string[] = [];
  const runtime = await startManagedSaasServer(
    deploymentFrom(environment),
    managedOptions(events, {
      environment,
    }),
  );
  try {
    assert.deepEqual(events.slice(0, 5), [
      'database-create',
      'database-ping',
      'schema-verify',
      'runtime-privileges-verify',
      'providers-ready',
    ]);
  } finally {
    await runtime.close();
  }
});

test('production startup fails closed on an unsafe runtime database role', async () => {
  const environment: DeploymentEnvironment = {
    ...managedEnvironment({ customer: 45_108, platform: 45_109, gateway: 45_110 }),
    NODE_ENV: 'production',
    [DEPLOYMENT_ENV_VARS.saas.workloadRole]: 'control-plane',
  };
  const events: string[] = [];
  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        environment,
        createDatabase: () => {
          events.push('database-create');
          return fakeDatabase(events, {
            ...SAFE_RUNTIME_PRIVILEGE_ROW,
            schema_create: true,
          });
        },
      }),
    ),
    /runtime privilege verification failed/,
  );
  assert.deepEqual(events, [
    'database-create',
    'database-ping',
    'schema-verify',
    'runtime-privileges-verify',
    'database-close',
  ]);
});

test('provider readiness failure closes PG before any listener is created', async () => {
  const environment = managedEnvironment({ customer: 45_111, platform: 45_112, gateway: 45_113 });
  const events: string[] = [];
  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(environment),
      managedOptions(events, {
        loadProviders: async () => {
          events.push('providers-failed');
          throw new Error('redis readiness unavailable');
        },
      }),
    ),
    /redis readiness unavailable/,
  );
  assert.deepEqual(events, ['database-create', 'database-ping', 'schema-verify', 'providers-failed', 'database-close']);
});

test('bind failure closes every created listener, providers, and PG', async () => {
  const occupied = await openServer();
  const free = await threeFreePorts();
  const environment = managedEnvironment({ customer: free.customer, platform: occupied.port, gateway: free.gateway });
  const events: string[] = [];
  const created = new Map<string, Server>();
  try {
    await assert.rejects(
      startManagedSaasServer(
        deploymentFrom(environment),
        managedOptions(events, {
          createListener: (name, handler) => {
            const server = http.createServer(handler);
            created.set(name, server);
            return server;
          },
        }),
      ),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
        return true;
      },
    );
    assert.equal(created.size, 3);
    for (const server of created.values()) assert.equal(server.listening, false);
    assert.equal(events.filter((event) => event === 'providers-close').length, 1);
    assert.equal(events.filter((event) => event === 'database-close').length, 1);
  } finally {
    await closeServer(occupied.server);
  }
});

test('local mode does not construct a SaaS database', async () => {
  const occupied = await openServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-local-startup-'));
  const configPath = path.join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'local-no-saas-db');
  config.admin.enabled = false;
  config.server.bindAddress = '127.0.0.1';
  config.server.port = occupied.port;
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${occupied.port}`;
  config.storage.dataDir = dir;
  fs.writeFileSync(configPath, JSON.stringify(config));
  let databaseCreated = 0;
  try {
    await assert.rejects(
      startServer(undefined, configPath, {
        environment: { [MODEL_ROUTER_DEPLOYMENT_MODE]: 'local' },
        managedSaas: {
          createDatabase: () => {
            databaseCreated += 1;
            throw new Error('SaaS database must not be constructed in local mode');
          },
        },
      }),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
        return true;
      },
    );
    assert.equal(databaseCreated, 0);
  } finally {
    await closeServer(occupied.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('customer webhook startup fails before database access when trusted dependencies are absent', async () => {
  const ports = await threeFreePorts();
  let databaseCreated = false;
  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(managedEnvironment(ports)),
      managedOptions([], {
        customerWebhooks: { enabled: true },
        createDatabase: () => {
          databaseCreated = true;
          return fakeDatabase([]);
        },
      }),
    ),
    /protector and egress dependencies are unavailable/,
  );
  assert.equal(databaseCreated, false);
});

test('customer webhook routes are rejected on gateway workload audiences', async () => {
  const ports = await threeFreePorts();
  let databaseCreated = false;
  const deployment = { ...deploymentFrom(managedEnvironment(ports)), workloadRole: 'gateway' as const };
  await assert.rejects(
    startManagedSaasServer(
      deployment,
      managedOptions([], {
        customerWebhooks: { enabled: true },
        createDatabase: () => {
          databaseCreated = true;
          return fakeDatabase([]);
        },
      }),
    ),
    /require a managed SaaS control-plane workload/,
  );
  assert.equal(databaseCreated, false);
});

test('enabled customer webhooks require the delivery schema before startup', async () => {
  const ports = await threeFreePorts();
  const events: string[] = [];
  const base = fakeDatabase(events);
  const database = {
    ...base,
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes('to_regclass(table_name)')) return { rows: [], rowCount: 0 };
      return base.query<Row>(sql, values);
    },
  } as unknown as ManagedSaasDatabase;
  const protector: WebhookSigningSecretProtector = {
    purpose: 'customer-webhook-signing-secret-v1',
    protect: async () => new Uint8Array([1]),
    unprotect: async () => new Uint8Array(32),
  };
  await assert.rejects(
    startManagedSaasServer(
      deploymentFrom(managedEnvironment(ports)),
      managedOptions(events, {
        environment: { NODE_ENV: 'test' },
        createDatabase: () => database,
        customerWebhooks: {
          enabled: true,
          signingSecretProtector: protector,
          egressTransport: new CustomerWebhookEgressTransport(),
        },
      }),
    ),
    /customer webhook schema verification failed/,
  );
  assert.equal(events.at(-1), 'database-close');
});

test('standard managed startup composes customer webhook routes and stops its delivery worker', async () => {
  const ports = await threeFreePorts();
  const environment = managedEnvironment(ports);
  const events: string[] = [];
  const base = fakeDatabase(events);
  const database = {
    ...base,
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes('to_regclass(table_name)')) {
        const names = values?.[0] as string[];
        return {
          rows: names.map((table_name) => ({ table_name, present: true })) as Row[],
          rowCount: names.length,
        };
      }
      return base.query<Row>(sql, values);
    },
  } as unknown as ManagedSaasDatabase;
  const protector: WebhookSigningSecretProtector = {
    purpose: 'customer-webhook-signing-secret-v1',
    protect: async () => new Uint8Array([1]),
    unprotect: async () => new Uint8Array(32),
  };
  const runtime = await startManagedSaasServer(deploymentFrom(environment), {
    ...managedOptions(events, {
      environment: { NODE_ENV: 'test' },
      createDatabase: () => database,
      customerWebhooks: {
        enabled: true,
        signingSecretProtector: protector,
        egressTransport: new CustomerWebhookEgressTransport(),
        intervalMs: 60_000,
      },
    }),
  });
  try {
    const customerAddress = origin(runtimeListener(runtime, 'customer'));
    const response = await fetch(
      `${customerAddress}/console/api/v1/tenants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/webhooks`,
    );
    assert.equal(response.status, 401);
    assert.match(await response.text(), /UNAUTHENTICATED/);
  } finally {
    await runtime.close();
  }
  assert.equal(events.filter((event) => event === 'database-close').length, 1);
});
