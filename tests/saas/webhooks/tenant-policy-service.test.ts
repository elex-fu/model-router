import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { CustomerWebhookTenantPolicyService } from '../../../src/saas/webhooks/tenant-policy-service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

class PolicyDatabase implements SaasDatabase {
  authorized = true;
  endpoints = 0;
  pending = 0;
  readonly calls: string[] = [];
  readonly audits: unknown[][] = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values: readonly unknown[] = []) => this.execute<Row>(sql, values) });
  }
  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim();
    this.calls.push(statement);
    if (statement.startsWith('SELECT 1 FROM saas_platform_role_assignments'))
      return result((this.authorized ? [{}] : []) as Row[]);
    if (statement.startsWith('SELECT tenant_id FROM saas_customer_webhook_tenant_policies')) return result([] as Row[]);
    if (statement.startsWith('SELECT (SELECT count(*) FROM saas_customer_webhook_endpoints')) {
      return result([{ active_endpoints: this.endpoints, pending_deliveries: this.pending }] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_audit_events')) {
      this.audits.push([...values]);
      return result([{}] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_tenant_policies')) {
      return result([
        {
          tenant_id: TENANT,
          enabled: values[1],
          max_active_endpoints: values[2],
          max_events_per_minute: values[3],
          max_pending_deliveries: values[4],
          revision: 1,
          updated_at: new Date('2026-09-29T00:00:00.000Z'),
        },
      ] as Row[]);
    }
    return result([] as Row[]);
  }
}

const INPUT = {
  enabled: true,
  maxActiveEndpoints: 10,
  maxEventsPerMinute: 120,
  maxPendingDeliveries: 2000,
};

test('only platform operations/superadmin may provision tenant webhook quotas; policy mutation is audited', async () => {
  const db = new PolicyDatabase();
  const service = new CustomerWebhookTenantPolicyService(db);
  const policy = await service.configure({ actorUserId: ACTOR, requestId: 'policy-request-1' }, TENANT, INPUT);
  assert.deepEqual(policy, {
    tenantId: TENANT,
    ...INPUT,
    revision: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(db.audits.length, 1);
  assert.ok(db.calls.some((sql) => sql.includes("role IN ('superadmin','operations')")));
  assert.ok(db.calls.some((sql) => sql.includes('pending_deliveries') && sql.includes('active_endpoints')));
  db.authorized = false;
  await assert.rejects(
    service.configure({ actorUserId: ACTOR, requestId: 'policy-request-2' }, TENANT, INPUT),
    /POLICY_FORBIDDEN/,
  );
  assert.equal(db.audits.length, 1);
});

test('platform may not lower tenant limits below current active endpoint or pending-delivery use', async () => {
  const db = new PolicyDatabase();
  db.endpoints = 11;
  const service = new CustomerWebhookTenantPolicyService(db);
  await assert.rejects(
    service.configure({ actorUserId: ACTOR, requestId: 'policy-request-1' }, TENANT, INPUT),
    /BELOW_CURRENT_USAGE/,
  );
  assert.equal(db.audits.length, 0);
  db.endpoints = 0;
  db.pending = 2001;
  await assert.rejects(
    service.configure({ actorUserId: ACTOR, requestId: 'policy-request-2' }, TENANT, INPUT),
    /BELOW_CURRENT_USAGE/,
  );
});
