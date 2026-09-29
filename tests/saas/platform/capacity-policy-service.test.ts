import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  CapacityPolicyError,
  type CapacityPolicyLimits,
  type CapacityPolicyReason,
  PlatformCapacityPolicyService,
} from '../../../src/saas/platform/capacity-policy-service.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const API_KEY_ID = '00000000-0000-4000-8000-000000000003';
const USER_ID = '00000000-0000-4000-8000-000000000004';
const SESSION_ID = '00000000-0000-4000-8000-000000000005';
const REQUEST_ID = '00000000-0000-4000-8000-000000000006';
const POLICY_LIMITS: CapacityPolicyLimits = {
  requestsPerMinute: 120,
  tokensPerMinute: 120_000,
  maxConcurrentRequests: 12,
};
const OPERATOR: PlatformAdminActor = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  roles: ['operations'],
};
const REASON: CapacityPolicyReason = 'capacity_adjustment';

type Row = Record<string, unknown>;

interface FakeState {
  sessions: Row[];
  roles: Row[];
  tenants: Row[];
  projects: Row[];
  policies: Row[];
  apiKeys: Row[];
  auditEvents: Row[];
  auditDetails: Row[];
}

function emptyLimits(): Row {
  return {
    requests_per_minute: null,
    tokens_per_minute: null,
    max_concurrent_requests: null,
  };
}

function initialState(): FakeState {
  return {
    sessions: [{ id: SESSION_ID, user_id: USER_ID, revoked_at: null, expires_at: '2099-01-01T00:00:00.000Z' }],
    roles: [{ role: 'operations' }],
    tenants: [{ id: TENANT_ID, capacity_policy_revision: '1', ...emptyLimits() }],
    projects: [
      {
        tenant_id: TENANT_ID,
        id: PROJECT_ID,
        inference_policy_version: '1',
        inference_policy_status: 'active',
      },
    ],
    policies: [
      {
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        version: '1',
        status: 'active',
        changed_by_user_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        ...emptyLimits(),
      },
    ],
    apiKeys: [
      {
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        id: API_KEY_ID,
        authz_version: '1',
        ...emptyLimits(),
        key_hash: 'never-selected',
      },
    ],
    auditEvents: [],
    auditDetails: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class CapacityPolicyDatabase implements SaasDatabase {
  state = initialState();
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  transactions = 0;
  failOn: 'audit-event' | 'audit-detail' | 'tenant-update' | 'project-head-update' | 'api-key-update' | null = null;
  malformedTenantRows = false;
  malformedProjectRows = false;
  malformedPolicyRows = false;
  malformedKeyRows = false;

  async query<RowType>(_sql: string, _values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    throw new Error('Capacity policy service must use the transaction executor');
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const before = clone(this.state);
    const tx: SqlExecutor = {
      query: <RowType>(sql: string, values: readonly unknown[] = []) => this.execute<RowType>(sql, values),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<RowType>(sql: string, values: readonly unknown[]): Promise<SqlResult<RowType>> {
    const statement = norm(sql);
    const lower = statement.toLowerCase();
    this.statements.push({ sql: statement, values: [...values] });

    if (
      lower.startsWith('set transaction isolation level') ||
      lower.startsWith('set local ') ||
      lower.startsWith('select pg_advisory_xact_lock_shared') ||
      lower.startsWith('select pg_advisory_xact_lock(')
    ) {
      return result<RowType>([]);
    }

    if (lower.startsWith('select s.id, s.user_id from saas_platform_sessions as s')) {
      const [sessionId, userId] = values;
      return result(
        this.state.sessions.filter(
          (row) => row.id === sessionId && row.user_id === userId && row.revoked_at === null,
        ) as RowType[],
      );
    }
    if (lower.startsWith('select role from saas_platform_role_assignments')) {
      return result(this.state.roles as RowType[]);
    }
    if (lower.startsWith('select id, capacity_policy_revision, requests_per_minute')) {
      const [tenantId] = values;
      const rows = this.state.tenants.filter((row) => row.id === tenantId);
      if (this.malformedTenantRows && rows[0]) rows.push({ ...rows[0] });
      return result(rows as RowType[]);
    }
    if (lower.startsWith('update saas_tenants')) {
      if (this.failOn === 'tenant-update') throw new Error('injected tenant update failure');
      const [tenantId, requestsPerMinute, tokensPerMinute, concurrency, expectedRevision] = values;
      const row = this.state.tenants.find(
        (candidate) => candidate.id === tenantId && candidate.capacity_policy_revision === String(expectedRevision),
      );
      if (!row) return result([]);
      Object.assign(row, {
        requests_per_minute: requestsPerMinute,
        tokens_per_minute: tokensPerMinute,
        max_concurrent_requests: concurrency,
        capacity_policy_revision: (BigInt(String(expectedRevision)) + 1n).toString(),
      });
      return result([row] as RowType[]);
    }
    if (
      lower.startsWith('select tenant_id, id, inference_policy_version, inference_policy_status from saas_projects')
    ) {
      const [tenantId, projectId] = values;
      const rows = this.state.projects.filter((row) => row.tenant_id === tenantId && row.id === projectId);
      if (this.malformedProjectRows && rows[0]) rows.push({ ...rows[0] });
      return result(rows as RowType[]);
    }
    if (lower.startsWith('select policy.tenant_id, policy.project_id, policy.version')) {
      const [tenantId, projectId, version] = values;
      const rows = this.state.policies
        .filter((row) => row.tenant_id === tenantId && row.project_id === projectId && row.version === String(version))
        .map((row) => ({
          ...row,
          latest_version: this.latestPolicyVersion(String(tenantId), String(projectId)),
        }));
      if (this.malformedPolicyRows && rows[0]) rows.push({ ...rows[0] });
      return result(rows as RowType[]);
    }
    if (lower.startsWith('insert into saas_project_inference_policy_versions')) {
      const [
        tenantId,
        projectId,
        currentVersion,
        nextVersion,
        actorId,
        requestsPerMinute,
        tokensPerMinute,
        concurrency,
      ] = values;
      const source = this.state.policies.find(
        (row) => row.tenant_id === tenantId && row.project_id === projectId && row.version === String(currentVersion),
      );
      if (!source) return result([]);
      if (
        this.state.policies.some(
          (row) => row.tenant_id === tenantId && row.project_id === projectId && row.version === nextVersion,
        )
      ) {
        throw new Error('duplicate project policy version');
      }
      const appended: Row = {
        tenant_id: tenantId,
        project_id: projectId,
        version: nextVersion,
        status: source.status,
        changed_by_user_id: actorId,
        created_at: '2026-09-29T00:00:00.000Z',
        requests_per_minute: requestsPerMinute,
        tokens_per_minute: tokensPerMinute,
        max_concurrent_requests: concurrency,
      };
      this.state.policies.push(appended);
      return result([
        {
          ...appended,
          latest_version: this.latestPolicyVersion(String(tenantId), String(projectId)),
        },
      ] as RowType[]);
    }
    if (lower.startsWith('update saas_projects')) {
      if (this.failOn === 'project-head-update') throw new Error('injected project head update failure');
      const [tenantId, projectId, nextVersion, expectedVersion] = values;
      const row = this.state.projects.find(
        (candidate) =>
          candidate.tenant_id === tenantId &&
          candidate.id === projectId &&
          candidate.inference_policy_version === String(expectedVersion),
      );
      if (!row) return result([]);
      row.inference_policy_version = String(nextVersion);
      return result([row] as RowType[]);
    }
    if (lower.startsWith('select tenant_id, project_id, id, authz_version, requests_per_minute')) {
      const [tenantId, projectId, apiKeyId] = values;
      const rows = this.state.apiKeys.filter(
        (row) => row.tenant_id === tenantId && row.project_id === projectId && row.id === apiKeyId,
      );
      if (this.malformedKeyRows && rows[0]) rows.push({ ...rows[0] });
      return result(rows as RowType[]);
    }
    if (lower.startsWith('update saas_api_keys')) {
      if (this.failOn === 'api-key-update') throw new Error('injected API key update failure');
      const [tenantId, projectId, apiKeyId, requestsPerMinute, tokensPerMinute, concurrency, expectedRevision] = values;
      const row = this.state.apiKeys.find(
        (candidate) =>
          candidate.tenant_id === tenantId &&
          candidate.project_id === projectId &&
          candidate.id === apiKeyId &&
          candidate.authz_version === String(expectedRevision),
      );
      if (!row) return result([]);
      Object.assign(row, {
        requests_per_minute: requestsPerMinute,
        tokens_per_minute: tokensPerMinute,
        max_concurrent_requests: concurrency,
        authz_version: (BigInt(String(expectedRevision)) + 1n).toString(),
      });
      return result([row] as RowType[]);
    }
    if (lower.startsWith('insert into saas_audit_events')) {
      if (this.failOn === 'audit-event') throw new Error('injected audit event failure');
      const [id, tenantId, actorId, targetType, targetId, requestId] = values;
      this.state.auditEvents.push({
        id,
        tenant_id: tenantId,
        actor_user_id: actorId,
        action: 'capacity_policy.updated',
        target_type: targetType,
        target_id: targetId,
        request_id: requestId,
        entry_point: 'platform_admin',
      });
      return result([{ id }] as RowType[]);
    }
    if (lower.startsWith('insert into saas_capacity_policy_audit_details')) {
      if (this.failOn === 'audit-detail') throw new Error('injected audit detail failure');
      const [
        auditEventId,
        scope,
        tenantId,
        projectId,
        apiKeyId,
        reason,
        revisionKind,
        beforeRevision,
        afterRevision,
        beforeRequestsPerMinute,
        beforeTokensPerMinute,
        beforeMaxConcurrentRequests,
        afterRequestsPerMinute,
        afterTokensPerMinute,
        afterMaxConcurrentRequests,
      ] = values;
      this.state.auditDetails.push({
        audit_event_id: auditEventId,
        scope,
        tenant_id: tenantId,
        project_id: projectId,
        api_key_id: apiKeyId,
        reason,
        revision_kind: revisionKind,
        before_revision: beforeRevision,
        after_revision: afterRevision,
        before_requests_per_minute: beforeRequestsPerMinute,
        before_tokens_per_minute: beforeTokensPerMinute,
        before_max_concurrent_requests: beforeMaxConcurrentRequests,
        after_requests_per_minute: afterRequestsPerMinute,
        after_tokens_per_minute: afterTokensPerMinute,
        after_max_concurrent_requests: afterMaxConcurrentRequests,
      });
      return result([{ audit_event_id: auditEventId }] as RowType[]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  private latestPolicyVersion(tenantId: string, projectId: string): string | null {
    const versions = this.state.policies
      .filter((row) => row.tenant_id === tenantId && row.project_id === projectId)
      .map((row) => BigInt(String(row.version)));
    return versions.length === 0 ? null : versions.reduce((left, right) => (left > right ? left : right)).toString();
  }
}

function createService(database = new CapacityPolicyDatabase()): {
  readonly database: CapacityPolicyDatabase;
  readonly service: PlatformCapacityPolicyService;
} {
  return { database, service: new PlatformCapacityPolicyService(database) };
}

function setBase(revision: string | number = 1) {
  return {
    expectedRevision: revision,
    limits: POLICY_LIMITS,
    reason: REASON,
    requestId: REQUEST_ID,
    actor: OPERATOR,
  };
}

function assertCapacityError(error: unknown, code: CapacityPolicyError['code']): boolean {
  assert.ok(error instanceof CapacityPolicyError);
  assert.equal(error.code, code);
  return true;
}

test('tenant capacity write uses row lock, revision CAS, and one atomic non-secret audit snapshot', async () => {
  const { database, service } = createService();
  const updated = await service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase() });

  assert.deepEqual(updated, {
    scope: 'tenant',
    tenantId: TENANT_ID,
    revision: '2',
    revisionKind: 'tenant_capacity_policy',
    limits: POLICY_LIMITS,
    configured: true,
  });
  assert.equal(database.state.tenants[0]?.capacity_policy_revision, '2');
  assert.equal(database.state.auditEvents.length, 1);
  assert.equal(database.state.auditDetails.length, 1);
  assert.equal(database.state.auditEvents[0]?.request_id, REQUEST_ID);
  assert.equal(database.state.auditEvents[0]?.actor_user_id, USER_ID);
  assert.deepEqual(database.state.auditDetails[0], {
    audit_event_id: database.state.auditEvents[0]?.id,
    scope: 'tenant',
    tenant_id: TENANT_ID,
    project_id: null,
    api_key_id: null,
    reason: REASON,
    revision_kind: 'tenant_capacity_policy',
    before_revision: '1',
    after_revision: '2',
    before_requests_per_minute: null,
    before_tokens_per_minute: null,
    before_max_concurrent_requests: null,
    after_requests_per_minute: POLICY_LIMITS.requestsPerMinute,
    after_tokens_per_minute: POLICY_LIMITS.tokensPerMinute,
    after_max_concurrent_requests: POLICY_LIMITS.maxConcurrentRequests,
  });
  const advisoryStatements = database.statements.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_xact_lock'));
  assert.deepEqual(
    advisoryStatements.map(({ values }) => values[0]),
    [`saas-authz:tenant:${TENANT_ID}`, USER_ID],
  );
  const lastFenceIndex = database.statements.reduce(
    (index, { sql }, current) => (sql.startsWith('SELECT pg_advisory_xact_lock') ? current : index),
    -1,
  );
  const rowLockIndex = database.statements.findIndex(({ sql }) =>
    sql.startsWith('SELECT id, capacity_policy_revision'),
  );
  assert.ok(lastFenceIndex >= 0 && rowLockIndex > lastFenceIndex);
  assert.match(
    database.statements.find(({ sql }) => sql.startsWith('SELECT id, capacity_policy_revision'))?.sql ?? '',
    /FOR UPDATE/,
  );
  assert.match(
    database.statements.find(({ sql }) => sql.startsWith('UPDATE saas_tenants'))?.sql ?? '',
    /capacity_policy_revision = capacity_policy_revision \+ 1/,
  );
  assert.ok(
    database.statements.findIndex(({ sql }) => sql.startsWith('UPDATE saas_tenants')) <
      database.statements.findIndex(({ sql }) => sql.startsWith('INSERT INTO saas_audit_events')),
  );
  assert.ok(
    database.statements.findIndex(({ sql }) => sql.startsWith('INSERT INTO saas_audit_events')) <
      database.statements.findIndex(({ sql }) => sql.startsWith('INSERT INTO saas_capacity_policy_audit_details')),
  );
});

test('tenant, project, and API-key read APIs return only metadata and identify unconfigured scopes', async () => {
  const { database, service } = createService();
  const tenant = await service.getTenantPolicy({ tenantId: TENANT_ID, actor: OPERATOR });
  const project = await service.getProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, actor: OPERATOR });
  const key = await service.getApiKeyPolicy({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    apiKeyId: API_KEY_ID,
    actor: OPERATOR,
  });

  assert.equal(tenant?.configured, false);
  assert.equal(tenant?.limits, null);
  assert.equal(project?.configured, false);
  assert.equal(key?.configured, false);
  assert.equal(key?.revisionKind, 'api_key_authz');
  assert.equal(JSON.stringify(key).includes('key_hash'), false);
  assert.ok(database.statements.every(({ sql }) => !/key_hash|prefix/i.test(sql)));
});

test('project policy write appends a new immutable version, copies non-capacity policy state, and switches the head', async () => {
  const { database, service } = createService();
  const historical = {
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    version: '1',
    status: 'suspended',
    changed_by_user_id: USER_ID,
    created_at: '2026-01-01T00:00:00.000Z',
    ...emptyLimits(),
  };
  const current = {
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    version: '2',
    status: 'active',
    changed_by_user_id: USER_ID,
    created_at: '2026-02-01T00:00:00.000Z',
    requests_per_minute: 100,
    tokens_per_minute: 100_000,
    max_concurrent_requests: 10,
  };
  const projectHead = database.state.projects[0];
  assert.ok(projectHead);
  projectHead.inference_policy_version = '2';
  database.state.policies = [historical, current];
  const before = clone(database.state.policies);

  const updated = await service.setProjectPolicy({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    ...setBase('2'),
  });

  assert.equal(updated.revision, '3');
  assert.equal(updated.scope, 'project');
  assert.equal(database.state.projects[0]?.inference_policy_version, '3');
  assert.equal(database.state.policies.length, 3);
  assert.deepEqual(database.state.policies.slice(0, 2), before);
  assert.equal(database.state.policies[2]?.status, 'active');
  assert.equal(database.state.policies[2]?.changed_by_user_id, USER_ID);
  assert.equal(database.state.policies[2]?.requests_per_minute, POLICY_LIMITS.requestsPerMinute);
  assert.equal(database.state.policies[2]?.tokens_per_minute, POLICY_LIMITS.tokensPerMinute);
  assert.equal(database.state.policies[2]?.max_concurrent_requests, POLICY_LIMITS.maxConcurrentRequests);
  assert.deepEqual(database.state.auditDetails[0], {
    audit_event_id: database.state.auditEvents[0]?.id,
    scope: 'project',
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    api_key_id: null,
    reason: REASON,
    revision_kind: 'project_inference_policy',
    before_revision: '2',
    after_revision: '3',
    before_requests_per_minute: 100,
    before_tokens_per_minute: 100_000,
    before_max_concurrent_requests: 10,
    after_requests_per_minute: POLICY_LIMITS.requestsPerMinute,
    after_tokens_per_minute: POLICY_LIMITS.tokensPerMinute,
    after_max_concurrent_requests: POLICY_LIMITS.maxConcurrentRequests,
  });
  assert.equal(
    database.statements.some(({ sql }) => /^UPDATE saas_project_inference_policy_versions/i.test(sql)),
    false,
  );
  assert.ok(database.statements.some(({ sql }) => /^INSERT INTO saas_project_inference_policy_versions/i.test(sql)));
  assert.ok(
    database.statements.some(({ sql }) =>
      /SELECT source\.tenant_id, source\.project_id, \$4, source\.status/i.test(sql),
    ),
  );
});

test('API-key write increments authz_version so stale authorization caches are invalidated', async () => {
  const { database, service } = createService();
  const updated = await service.setApiKeyPolicy({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    apiKeyId: API_KEY_ID,
    ...setBase(),
  });

  assert.equal(updated.revision, '2');
  assert.equal(updated.revisionKind, 'api_key_authz');
  assert.equal(database.state.apiKeys[0]?.authz_version, '2');
  assert.equal(database.state.auditDetails[0]?.before_revision, '1');
  assert.equal(database.state.auditDetails[0]?.after_revision, '2');
  assert.match(
    database.statements.find(({ sql }) => sql.startsWith('UPDATE saas_api_keys'))?.sql ?? '',
    /authz_version = authz_version \+ 1/,
  );
});

test('support-readonly cannot write and stale actor roles are rejected against the database', async () => {
  const first = createService();
  const readonlyActor: PlatformAdminActor = { ...OPERATOR, roles: ['support-readonly'] };
  const start = first.database.statements.length;
  await assert.rejects(
    first.service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase(), actor: readonlyActor }),
    (error: unknown) => assertCapacityError(error, 'FORBIDDEN'),
  );
  assert.equal(first.database.statements.length, start);
  assert.equal(first.database.state.tenants[0]?.capacity_policy_revision, '1');

  const second = createService();
  second.database.state.roles = [{ role: 'security' }];
  await assert.rejects(second.service.getTenantPolicy({ tenantId: TENANT_ID, actor: OPERATOR }), (error: unknown) =>
    assertCapacityError(error, 'FORBIDDEN'),
  );
  assert.equal(second.database.statements.filter(({ sql }) => sql.includes('FROM saas_tenants')).length, 0);
});

test('expired/revoked platform sessions cannot read or write even with a claimed operations role', async () => {
  const { database, service } = createService();
  const session = database.state.sessions[0];
  assert.ok(session);
  session.revoked_at = '2026-09-28T00:00:00.000Z';

  await assert.rejects(service.getTenantPolicy({ tenantId: TENANT_ID, actor: OPERATOR }), (error: unknown) =>
    assertCapacityError(error, 'FORBIDDEN'),
  );
  assert.equal(
    database.statements.some(({ sql }) => sql.includes('FROM saas_tenants')),
    false,
  );
});

test('stale tenant, project, and API-key revisions conflict before audit or mutation', async () => {
  const { database, service } = createService();
  const tenant = database.state.tenants[0];
  const project = database.state.projects[0];
  const apiKey = database.state.apiKeys[0];
  assert.ok(tenant && project && apiKey);
  tenant.capacity_policy_revision = '2';
  project.inference_policy_version = '2';
  database.state.policies.push({
    ...database.state.policies[0],
    version: '2',
    changed_by_user_id: USER_ID,
  });
  apiKey.authz_version = '2';

  const before = clone(database.state);
  await assert.rejects(service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase(1) }), (error: unknown) =>
    assertCapacityError(error, 'CAS_CONFLICT'),
  );
  await assert.rejects(
    service.setProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, ...setBase(1) }),
    (error: unknown) => assertCapacityError(error, 'CAS_CONFLICT'),
  );
  await assert.rejects(
    service.setApiKeyPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, apiKeyId: API_KEY_ID, ...setBase(1) }),
    (error: unknown) => assertCapacityError(error, 'CAS_CONFLICT'),
  );
  assert.deepEqual(database.state, before);
  assert.equal(database.state.auditEvents.length, 0);
  assert.equal(database.state.auditDetails.length, 0);
});

test('partial, null, unsafe, coerced, and non-positive input limits are rejected before SQL', async () => {
  const invalidLimits: unknown[] = [
    null,
    {},
    { ...POLICY_LIMITS, tokensPerMinute: null },
    { ...POLICY_LIMITS, requestsPerMinute: '120' },
    { ...POLICY_LIMITS, requestsPerMinute: Number.MAX_SAFE_INTEGER + 1 },
    { ...POLICY_LIMITS, requestsPerMinute: 1.5 },
    { ...POLICY_LIMITS, tokensPerMinute: 0 },
    { ...POLICY_LIMITS, tokensPerMinute: -1 },
    { ...POLICY_LIMITS, maxConcurrentRequests: 2_147_483_648 },
    { ...POLICY_LIMITS, unexpected: 1 },
  ];
  for (const limits of invalidLimits) {
    const { database, service } = createService();
    await assert.rejects(
      service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase(), limits: limits as CapacityPolicyLimits }),
      (error: unknown) => assertCapacityError(error, 'INVALID_INPUT'),
    );
    assert.equal(database.transactions, 0);
    assert.equal(database.statements.length, 0);
  }
});

test('reason is a bounded non-sensitive code and request id must be a UUID', async () => {
  const { database, service } = createService();
  await assert.rejects(
    service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase(), reason: 'sk-secret-value' as CapacityPolicyReason }),
    (error: unknown) => assertCapacityError(error, 'INVALID_INPUT'),
  );
  await assert.rejects(
    service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase(), requestId: 'Authorization: Bearer secret' }),
    (error: unknown) => assertCapacityError(error, 'INVALID_INPUT'),
  );
  assert.equal(database.transactions, 0);
});

test('scope-mismatched extra fields and missing fields are rejected', async () => {
  const { database, service } = createService();
  await assert.rejects(
    service.setTenantPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, ...setBase() } as never),
    (error: unknown) => assertCapacityError(error, 'INVALID_INPUT'),
  );
  await assert.rejects(service.setProjectPolicy({ tenantId: TENANT_ID, ...setBase() } as never), (error: unknown) =>
    assertCapacityError(error, 'INVALID_INPUT'),
  );
  assert.equal(database.transactions, 0);
});

test('database partial capacity rows fail closed instead of being normalized or partially accepted', async () => {
  const { database, service } = createService();
  const tenant = database.state.tenants[0];
  assert.ok(tenant);
  tenant.requests_per_minute = 100;

  await assert.rejects(service.getTenantPolicy({ tenantId: TENANT_ID, actor: OPERATOR }), (error: unknown) =>
    assertCapacityError(error, 'INVALID_POLICY'),
  );
  assert.equal(database.state.auditEvents.length, 0);
});

test('ambiguous tenant, project head, policy, and API-key rows fail closed', async () => {
  const cases: Array<(database: CapacityPolicyDatabase) => void> = [
    (database) => {
      database.malformedTenantRows = true;
    },
    (database) => {
      database.malformedProjectRows = true;
    },
    (database) => {
      database.malformedPolicyRows = true;
    },
    (database) => {
      database.malformedKeyRows = true;
    },
  ];
  const calls = [
    (service: PlatformCapacityPolicyService) => service.getTenantPolicy({ tenantId: TENANT_ID, actor: OPERATOR }),
    (service: PlatformCapacityPolicyService) =>
      service.getProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, actor: OPERATOR }),
    (service: PlatformCapacityPolicyService) =>
      service.getApiKeyPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, apiKeyId: API_KEY_ID, actor: OPERATOR }),
  ];
  const expected: Array<CapacityPolicyError['code']> = ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS'];
  for (let index = 0; index < cases.length; index += 1) {
    const { database, service } = createService();
    cases[index]?.(database);
    const call = index === 0 ? calls[0] : index === 1 || index === 2 ? calls[1] : calls[2];
    await assert.rejects(call?.(service), (error: unknown) =>
      assertCapacityError(error, expected[index] ?? 'STORAGE_ERROR'),
    );
  }
});

test('non-current latest project version is rejected as ambiguous policy authority', async () => {
  const { database, service } = createService();
  database.state.policies.push({
    ...database.state.policies[0],
    version: '2',
  });

  await assert.rejects(
    service.getProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, actor: OPERATOR }),
    (error: unknown) => assertCapacityError(error, 'INVALID_POLICY'),
  );
});

test('audit event failure rolls the scope mutation back', async () => {
  const { database, service } = createService();
  database.failOn = 'audit-event';
  const before = clone(database.state);

  await assert.rejects(service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase() }), (error: unknown) =>
    assertCapacityError(error, 'STORAGE_ERROR'),
  );
  assert.deepEqual(database.state, before);
});

test('capacity detail failure rolls back the mutation and parent audit event atomically', async () => {
  const { database, service } = createService();
  database.failOn = 'audit-detail';
  const before = clone(database.state);

  await assert.rejects(service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase() }), (error: unknown) =>
    assertCapacityError(error, 'STORAGE_ERROR'),
  );
  assert.deepEqual(database.state, before);
  assert.equal(database.state.auditEvents.length, 0);
  assert.equal(database.state.auditDetails.length, 0);
});

test('project head CAS conflict and API-key update failure do not leave appended versions or audit', async () => {
  const { database, service } = createService();
  const initial = clone(database.state);
  database.failOn = 'project-head-update';
  await assert.rejects(
    service.setProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, ...setBase() }),
    (error: unknown) => assertCapacityError(error, 'STORAGE_ERROR'),
  );
  assert.deepEqual(database.state, initial);

  database.failOn = 'api-key-update';
  await assert.rejects(
    service.setApiKeyPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, apiKeyId: API_KEY_ID, ...setBase() }),
    (error: unknown) => assertCapacityError(error, 'STORAGE_ERROR'),
  );
  assert.deepEqual(database.state, initial);
});

test('same positive limits are rejected as a no-op without a revision bump or audit event', async () => {
  const { database, service } = createService();
  Object.assign(database.state.tenants[0], {
    requests_per_minute: POLICY_LIMITS.requestsPerMinute,
    tokens_per_minute: POLICY_LIMITS.tokensPerMinute,
    max_concurrent_requests: POLICY_LIMITS.maxConcurrentRequests,
  });

  await assert.rejects(service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase() }), (error: unknown) =>
    assertCapacityError(error, 'NO_CHANGE'),
  );
  assert.equal(database.state.tenants[0]?.capacity_policy_revision, '1');
  assert.equal(database.state.auditEvents.length, 0);
});

test('every scope write persists a single whitelisted revision detail and never a secret-bearing API-key field', async () => {
  const { database, service } = createService();
  await service.setTenantPolicy({ tenantId: TENANT_ID, ...setBase() });
  await service.setProjectPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, ...setBase() });
  await service.setApiKeyPolicy({ tenantId: TENANT_ID, projectId: PROJECT_ID, apiKeyId: API_KEY_ID, ...setBase() });

  assert.deepEqual(
    database.state.auditDetails.map((detail) => detail.scope),
    ['tenant', 'project', 'api_key'],
  );
  assert.equal(database.state.auditDetails.length, database.state.auditEvents.length);
  assert.ok(database.state.auditDetails.every((detail) => detail.reason === REASON));
  assert.ok(database.state.auditDetails.every((detail) => !('key_hash' in detail) && !('secret' in detail)));
  assert.equal(
    database.statements.some(({ sql }) => /key_hash|secret_value|api_key_secret/i.test(sql)),
    false,
  );
});
