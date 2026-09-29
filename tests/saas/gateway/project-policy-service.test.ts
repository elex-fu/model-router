import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type ProjectInferencePolicyStatus,
  SaasProjectInferencePolicyError,
  SaasProjectInferencePolicyService,
} from '../../../src/saas/gateway/project-policy-service.js';

type Row = Record<string, unknown>;

interface PolicyState {
  head: {
    tenant_id: string;
    id: string;
    inference_policy_version: string;
    inference_policy_status: ProjectInferencePolicyStatus;
  };
  policies: Row[];
  audits: Row[];
}

function initialState(): PolicyState {
  return {
    head: {
      tenant_id: 'tenant-a',
      id: 'project-a',
      inference_policy_version: '1',
      inference_policy_status: 'suspended',
    },
    policies: [],
    audits: [],
  };
}

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

class PolicyExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  readonly advisoryFenceKeys: string[] = [];

  constructor(
    readonly state: PolicyState,
    private readonly failAudit = false,
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    const statement = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(statement);
    if (statement.startsWith('SELECT set_config(')) return result([]);
    if (statement.startsWith('SELECT pg_advisory_xact_lock')) {
      if (!statement.includes('(1396788563, 46)')) this.advisoryFenceKeys.push(String(values[0]));
      return result([]);
    }
    if (statement.startsWith('SELECT tenant_id, id, inference_policy_version')) {
      return result([this.state.head] as RowType[]);
    }
    if (statement.startsWith('INSERT INTO saas_project_inference_policy_versions')) {
      this.state.policies.push({
        tenant_id: values[0],
        project_id: values[1],
        version: values[2],
        status: values[3],
        changed_by_user_id: values[4],
        created_at: values[5],
      });
      return result([]);
    }
    if (statement.startsWith('UPDATE saas_projects')) {
      const [tenantId, projectId, nextVersion, nextStatus, _now, expectedVersion, expectedStatus] = values;
      if (
        this.state.head.tenant_id !== tenantId ||
        this.state.head.id !== projectId ||
        this.state.head.inference_policy_version !== String(expectedVersion) ||
        this.state.head.inference_policy_status !== expectedStatus
      ) {
        return result([]);
      }
      this.state.head = {
        ...this.state.head,
        inference_policy_version: String(nextVersion),
        inference_policy_status: nextStatus as ProjectInferencePolicyStatus,
      };
      return result([this.state.head] as RowType[]);
    }
    if (statement.startsWith('INSERT INTO saas_audit_events')) {
      if (this.failAudit) throw new Error('injected audit failure');
      this.state.audits.push({ values: [...values] });
      return result([]);
    }
    if (statement.startsWith('SELECT tenant_id, project_id, version, status')) {
      const [tenantId, projectId, policyVersion] = values;
      return result(
        this.state.policies.filter(
          (row) => row.tenant_id === tenantId && row.project_id === projectId && row.version === policyVersion,
        ) as RowType[],
      );
    }
    throw new Error(`unexpected policy SQL: ${statement}`);
  }
}

class PolicyDatabase implements SaasDatabase {
  state = initialState();
  readonly executors: PolicyExecutor[] = [];
  failAudit = false;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return new PolicyExecutor(this.state, this.failAudit).query(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    const executor = new PolicyExecutor(this.state, this.failAudit);
    this.executors.push(executor);
    try {
      return await work(executor);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function input(status: ProjectInferencePolicyStatus, expectedVersion = 1) {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    expectedVersion,
    status,
    audit: {
      actorUserId: 'user-a',
      entryPoint: 'console_project_policy',
      sourceIp: '192.0.2.10',
      userAgent: 'test-agent',
      requestId: 'request-a',
    },
  };
}

function createService(database: PolicyDatabase): SaasProjectInferencePolicyService {
  return new SaasProjectInferencePolicyService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
}

test('policy service enables, suspends, and disables with versioned CAS and same-transaction audit', async () => {
  const database = new PolicyDatabase();
  const service = createService(database);

  const enabled = await service.enable(input('active', 1));
  assert.deepEqual(enabled, {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    version: '2',
    status: 'active',
    changedByUserId: 'user-a',
    createdAt: '2026-09-28T00:00:00.000Z',
  });
  assert.equal(database.state.head.inference_policy_status, 'active');
  assert.equal(database.state.policies.length, 1);
  assert.equal(database.state.audits.length, 1);
  const auditValues = database.state.audits[0]?.values;
  assert.ok(Array.isArray(auditValues));
  assert.match(String(auditValues[3]), /project_inference_policy\.active/);
  const writerFenceIndex = database.executors[0]?.statements.findIndex((statement) =>
    statement.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const firstEntityFenceIndex = database.executors[0]?.statements.indexOf(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
  );
  const projectRowLockIndex = database.executors[0]?.statements.findIndex(
    (statement) => statement.includes('FROM saas_projects') && statement.includes('FOR UPDATE'),
  );
  assert.ok(
    writerFenceIndex !== undefined &&
      firstEntityFenceIndex !== undefined &&
      projectRowLockIndex !== undefined &&
      writerFenceIndex < firstEntityFenceIndex &&
      firstEntityFenceIndex < projectRowLockIndex,
  );
  assert.deepEqual(
    database.executors[0]?.statements
      .filter(
        (statement) =>
          !statement.startsWith('SELECT set_config(') && !statement.startsWith('SELECT pg_advisory_xact_lock'),
      )
      .map((statement) => statement.split(' ')[0]),
    ['SELECT', 'INSERT', 'UPDATE', 'INSERT'],
  );
  assert.deepEqual(database.executors[0]?.advisoryFenceKeys, [
    'saas-authz:tenant:tenant-a',
    'saas-authz:project:tenant-a:project-a',
    'user-a',
  ]);

  const suspended = await service.suspend(input('suspended', 2));
  assert.equal(suspended.version, '3');
  assert.equal(suspended.status, 'suspended');
  const disabled = await service.disable(input('disabled', 3));
  assert.equal(disabled.version, '4');
  assert.equal(disabled.status, 'disabled');
  assert.equal(database.state.audits.length, 3);
});

test('policy service rejects a stale expected version before creating a new policy or audit', async () => {
  const database = new PolicyDatabase();
  const service = createService(database);
  await service.enable(input('active', 1));

  await assert.rejects(service.suspend(input('suspended', 1)), (error: unknown) => {
    assert.ok(error instanceof SaasProjectInferencePolicyError);
    assert.equal(error.code, 'CAS_CONFLICT');
    return true;
  });
  assert.equal(database.state.policies.length, 1);
  assert.equal(database.state.audits.length, 1);
});

test('policy audit failure rolls back the policy insert and head update', async () => {
  const database = new PolicyDatabase();
  database.failAudit = true;
  const service = createService(database);
  const before = structuredClone(database.state);

  await assert.rejects(service.enable(input('active', 1)), (error: unknown) => {
    assert.ok(error instanceof SaasProjectInferencePolicyError);
    assert.equal(error.code, 'STORAGE_ERROR');
    return true;
  });
  assert.deepEqual(database.state, before);
});

test('policy reads never turn a missing version into execution authority', async () => {
  const database = new PolicyDatabase();
  const service = createService(database);
  assert.equal(await service.get('tenant-a', 'project-a', 1), null);
});
