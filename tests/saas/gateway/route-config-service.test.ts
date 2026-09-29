import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type RouteConfigDefinition,
  SaasRouteConfigError,
  SaasRouteConfigService,
} from '../../../src/saas/gateway/route-config-service.js';

type Row = Record<string, unknown>;

interface Head {
  tenant_id: string;
  project_id: string;
  route_id: string;
  current_version: string;
  status: 'draft' | 'active' | 'disabled';
}

interface Version extends Head {
  public_model_id: string;
  public_model_version: string;
  protocol: 'openai' | 'anthropic' | 'gemini' | 'responses';
  supply_mode: 'byok' | 'platform';
  target_mode: 'tenant_account' | 'platform_pool';
  upstream_id: string;
  endpoint: string;
  changed_by_user_id: string;
  created_at: string;
}

interface FakeState {
  heads: Head[];
  versions: Version[];
  audits: Row[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

function key(tenantId: unknown, projectId: unknown, routeId: unknown): string {
  return `${String(tenantId)}:${String(projectId)}:${String(routeId)}`;
}

class FakeRouteDatabase implements SaasDatabase {
  readonly sql: string[] = [];
  state: FakeState = { heads: [], versions: [], audits: [] };
  failAudit = false;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return result(this.execute(sql.replace(/\s+/g, ' ').trim(), values) as RowType[]);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const snapshot = clone(this.state);
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

  private execute(sql: string, values: readonly unknown[]): Row[] {
    this.sql.push(sql);
    if (/pg_advisory_xact_lock|set_config\(/i.test(sql)) return [];
    if (
      sql.startsWith('SELECT tenant_id, project_id, route_id, current_version, status FROM saas_route_config_heads')
    ) {
      const [tenantId, projectId, routeId] = values;
      return this.state.heads.filter(
        (head) => key(head.tenant_id, head.project_id, head.route_id) === key(tenantId, projectId, routeId),
      );
    }
    if (sql.startsWith('INSERT INTO saas_route_config_versions')) {
      const [
        tenantId,
        projectId,
        routeId,
        version,
        status,
        publicModelId,
        publicModelVersion,
        protocol,
        supplyMode,
        targetMode,
        upstreamId,
        endpoint,
        actor,
        createdAt,
      ] = values;
      const row: Version = {
        tenant_id: String(tenantId),
        project_id: String(projectId),
        route_id: String(routeId),
        current_version: String(version),
        version: String(version),
        status: status as Version['status'],
        public_model_id: String(publicModelId),
        public_model_version: String(publicModelVersion),
        protocol: protocol as Version['protocol'],
        supply_mode: supplyMode as Version['supply_mode'],
        target_mode: targetMode as Version['target_mode'],
        upstream_id: String(upstreamId),
        endpoint: String(endpoint),
        changed_by_user_id: String(actor),
        created_at: String(createdAt),
      };
      this.state.versions.push(row);
      return [];
    }
    if (sql.startsWith('INSERT INTO saas_route_config_heads')) {
      const [tenantId, projectId, routeId, actor, createdAt] = values;
      this.state.heads.push({
        tenant_id: String(tenantId),
        project_id: String(projectId),
        route_id: String(routeId),
        current_version: '1',
        status: 'draft',
      });
      void actor;
      void createdAt;
      return [];
    }
    if (sql.startsWith('SELECT tenant_id, project_id, route_id, version, status, public_model_id')) {
      const [tenantId, projectId, routeId, version] = values;
      return this.state.versions.filter(
        (row) =>
          row.tenant_id === String(tenantId) &&
          row.project_id === String(projectId) &&
          row.route_id === String(routeId) &&
          row.version === String(version),
      );
    }
    if (sql.startsWith('UPDATE saas_route_config_heads')) {
      const [tenantId, projectId, routeId, nextVersion, status, actor, updatedAt, expectedVersion] = values;
      const row = this.state.heads.find(
        (head) =>
          key(head.tenant_id, head.project_id, head.route_id) === key(tenantId, projectId, routeId) &&
          head.current_version === String(expectedVersion),
      );
      if (!row) return [];
      row.current_version = String(nextVersion);
      row.status = status as Head['status'];
      void actor;
      void updatedAt;
      return [row];
    }
    if (sql.startsWith('INSERT INTO saas_audit_events')) {
      if (this.failAudit) throw new Error('audit storage failed');
      this.state.audits.push({ action: values[3], target_id: values[4] });
      return [];
    }
    if (sql.startsWith('SELECT rv.tenant_id, rv.project_id, rv.route_id, rv.version, rv.status')) {
      const [tenantId, projectId, publicModel, protocol, supplyMode] = values;
      return this.state.versions.filter((row) => {
        const head = this.state.heads.find(
          (candidate) =>
            key(candidate.tenant_id, candidate.project_id, candidate.route_id) ===
            key(row.tenant_id, row.project_id, row.route_id),
        );
        return (
          row.tenant_id === String(tenantId) &&
          row.project_id === String(projectId) &&
          head?.current_version === row.version &&
          head.status === 'active' &&
          row.status === 'active' &&
          row.public_model_id === 'public-model-a' &&
          String(publicModel) === 'model-a' &&
          row.protocol === protocol &&
          row.supply_mode === supplyMode
        );
      });
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

test('route head writers take the 047 writer fence before plain head/history reads', async () => {
  const database = new FakeRouteDatabase();
  const routes = service(database);

  await routes.create({ tenantId: 'tenant-a', projectId: 'project-a', routeId: 'route-a', definition, audit });
  const createWriterFence = database.sql.findIndex((sql) => /pg_advisory_xact_lock\(1396788563, 46\)/i.test(sql));
  assert.ok(createWriterFence >= 0);
  assert.match(database.sql[createWriterFence - 1] ?? '', /statement_timeout/i);
  assert.match(database.sql[createWriterFence + 1] ?? '', /saas-authz:project:/i);
  const createHeadRead = database.sql.findIndex((sql) => /FROM saas_route_config_heads/i.test(sql));
  assert.ok(createHeadRead > createWriterFence + 1);
  assert.doesNotMatch(database.sql[createHeadRead] ?? '', /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);

  await routes.publish({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    expectedVersion: 1,
    audit,
  });
  const publishSql = database.sql.slice(createHeadRead + 1);
  const publishWriterFence = publishSql.findIndex((sql) => /pg_advisory_xact_lock\(1396788563, 46\)/i.test(sql));
  assert.ok(publishWriterFence >= 0);
  const publishHeadRead = publishSql.findIndex((sql) => /FROM saas_route_config_heads/i.test(sql));
  assert.ok(publishHeadRead > publishWriterFence + 1);
  assert.doesNotMatch(publishSql[publishHeadRead] ?? '', /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  const immutableVersionRead = publishSql.find((sql) => /FROM saas_route_config_versions/i.test(sql));
  assert.ok(immutableVersionRead);
  assert.doesNotMatch(immutableVersionRead, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);

  await routes.resolve({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    publicModel: 'model-a',
    protocol: 'openai',
    supplyMode: 'byok',
  });
  const resolveSql = database.sql.slice(-2);
  assert.match(resolveSql[0] ?? '', /pg_advisory_xact_lock_shared[\s\S]*saas-authz:project:/i);
  assert.match(resolveSql[1] ?? '', /FROM saas_route_config_heads/i);
  assert.doesNotMatch(resolveSql[1] ?? '', /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

const definition: RouteConfigDefinition = {
  publicModelId: 'public-model-a',
  publicModelVersion: 1,
  protocol: 'openai',
  supplyMode: 'byok',
  targetMode: 'tenant_account',
  upstreamId: 'upstream-a',
  endpoint: '/v1/chat/completions',
};

const audit = { actorUserId: 'user-a', entryPoint: 'test' };

function service(database: FakeRouteDatabase): SaasRouteConfigService {
  return new SaasRouteConfigService(database, { now: () => new Date('2026-09-28T00:00:00.000Z') });
}

test('creates a draft, publishes an immutable replacement, and resolves exact model/protocol/mode authority', async () => {
  const database = new FakeRouteDatabase();
  const routes = service(database);
  const draft = await routes.create({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    definition,
    audit,
  });
  assert.equal(draft.version, '1');
  assert.equal(draft.status, 'draft');
  assert.match(
    database.sql.find((sql) => sql.startsWith('INSERT INTO saas_route_config_versions')) ?? '',
    /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14\)/,
  );

  const published = await routes.publish({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    expectedVersion: 1,
    definition,
    audit,
  });
  assert.equal(published.version, '2');
  assert.equal(published.status, 'active');
  assert.equal(database.state.versions.length, 2);
  assert.deepEqual(
    database.state.versions.map((row) => row.status),
    ['draft', 'active'],
  );
  assert.equal(database.state.audits.length, 2);

  const resolved = await routes.resolve({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    publicModel: 'model-a',
    protocol: 'openai',
    supplyMode: 'byok',
  });
  assert.equal(resolved.version, '2');
  assert.equal(resolved.upstreamId, 'upstream-a');

  const replacement = await routes.publish({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    expectedVersion: 2,
    definition: { ...definition, upstreamId: 'upstream-b' },
    audit,
  });
  assert.equal(replacement.version, '3');
  assert.equal(database.state.versions[1]?.upstream_id, 'upstream-a');
  assert.equal(
    (
      await routes.resolve({
        tenantId: 'tenant-a',
        projectId: 'project-a',
        publicModel: 'model-a',
        protocol: 'openai',
        supplyMode: 'byok',
      })
    ).upstreamId,
    'upstream-b',
  );
});

test('CAS conflict and audit failure do not create a route version or head mutation', async () => {
  const database = new FakeRouteDatabase();
  const routes = service(database);
  await routes.create({ tenantId: 'tenant-a', projectId: 'project-a', routeId: 'route-a', definition, audit });

  await assert.rejects(
    routes.publish({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      routeId: 'route-a',
      expectedVersion: 9,
      definition,
      audit,
    }),
    (error: unknown) => error instanceof SaasRouteConfigError && error.code === 'CAS_CONFLICT',
  );
  assert.equal(database.state.versions.length, 1);

  database.failAudit = true;
  await assert.rejects(
    routes.publish({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      routeId: 'route-a',
      expectedVersion: 1,
      definition,
      audit,
    }),
    (error: unknown) => error instanceof SaasRouteConfigError && error.code === 'STORAGE_ERROR',
  );
  assert.equal(database.state.versions.length, 1);
  assert.equal(database.state.heads[0]?.current_version, '1');
  assert.equal(database.state.audits.length, 1);
});

test('unpublished, disabled, and target-mode-invalid routes fail closed', async () => {
  const database = new FakeRouteDatabase();
  const routes = service(database);
  await assert.rejects(
    routes.resolve({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: 'model-a',
      protocol: 'openai',
      supplyMode: 'byok',
    }),
    (error: unknown) => error instanceof SaasRouteConfigError && error.code === 'UNPUBLISHED',
  );
  await assert.rejects(
    routes.create({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      routeId: 'invalid-route',
      definition: { ...definition, targetMode: 'platform_pool' },
      audit,
    }),
    (error: unknown) => error instanceof SaasRouteConfigError && error.code === 'TARGET_MODE_MISMATCH',
  );

  await routes.create({ tenantId: 'tenant-a', projectId: 'project-a', routeId: 'route-a', definition, audit });
  await routes.disable({ tenantId: 'tenant-a', projectId: 'project-a', routeId: 'route-a', expectedVersion: 1, audit });
  await assert.rejects(
    routes.resolve({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: 'model-a',
      protocol: 'openai',
      supplyMode: 'byok',
    }),
    (error: unknown) => error instanceof SaasRouteConfigError && error.code === 'UNPUBLISHED',
  );
});

test('a platform route requires the platform pool target mode and is resolved separately from BYOK', async () => {
  const database = new FakeRouteDatabase();
  const routes = service(database);
  const platformDefinition: RouteConfigDefinition = {
    ...definition,
    supplyMode: 'platform',
    targetMode: 'platform_pool',
    upstreamId: 'platform-upstream-a',
  };
  await routes.create({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'platform-route',
    definition: platformDefinition,
    audit,
  });
  await routes.publish({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'platform-route',
    expectedVersion: 1,
    audit,
  });
  const resolved = await routes.resolve({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    publicModel: 'model-a',
    protocol: 'openai',
    supplyMode: 'platform',
  });
  assert.equal(resolved.targetMode, 'platform_pool');
  assert.equal(resolved.upstreamId, 'platform-upstream-a');
});
