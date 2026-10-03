import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ConsoleRequest,
  type ConsoleUsageSummaryBucket,
  SaasConsoleQueryError,
  SaasConsoleUsageQueryService,
} from '../../../src/saas/console/index.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';

type Row = Record<string, unknown>;

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function requestRow(id: string, createdAt: string): Row {
  return {
    id,
    project_id: 'project-a',
    model: 'model-a',
    protocol: 'openai',
    supply_mode: 'platform',
    status: 'succeeded',
    financial_status: 'settled',
    reconciliation_state: 'resolved',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function usageSummaryRow(): Row {
  return {
    request_count: '2',
    event_count: '3',
    input_total: '900719925474099312345',
    input_uncached: '900719925474099312300',
    cache_read: '45',
    cache_write: '0',
    cache_write_5m: '0',
    cache_write_1h: '0',
    output_total: '55',
    reasoning_output: '5',
    total_tokens: '900719925474099312400',
  };
}

function usageBucketRow(): Row {
  return {
    period_start: '2026-09-27T00:00:00.000Z',
    project_id: 'project-a',
    model: 'model-a',
    supply_mode: 'platform',
    status: 'succeeded',
    ...usageSummaryRow(),
  };
}

class RecordingDatabase implements SqlExecutor {
  readonly calls: QueryCall[] = [];
  requestRows: Row[] = [];
  detailRequest: Row | null = requestRow('request-a', '2026-09-28T01:00:00.000Z');
  attemptRows: Row[] = [];
  usageRows: Row[] = [];
  summaryRows: Row[] = [usageSummaryRow()];
  bucketRows: Row[] = [usageBucketRow()];
  fail = false;
  allowedUserId = 'user-a';
  allowedTenantId = 'tenant-a';
  allowProjectMembership = true;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.calls.push({ sql, values });
    if (this.fail) throw new Error('database secret details must not escape');

    const statement = sql.replace(/\s+/g, ' ').trim();
    if (values[0] !== this.allowedUserId || values[1] !== this.allowedTenantId) return result<RowType>([]);
    if (statement.includes('saas_project_memberships') && !this.allowProjectMembership) {
      return result<RowType>([]);
    }
    if (statement.includes('FROM saas_attempts AS a')) return result<RowType>(this.attemptRows as RowType[]);
    if (statement.includes('FROM saas_usage_events AS e') && !statement.includes('GROUP BY')) {
      return result<RowType>(this.usageRows as RowType[]);
    }
    if (statement.includes('GROUP BY date_trunc')) return result<RowType>(this.bucketRows as RowType[]);
    if (statement.includes('GROUP BY auth.user_id')) return result<RowType>(this.summaryRows as RowType[]);
    if (statement.includes('FROM saas_requests AS r') && statement.includes('LIMIT 1')) {
      return result<RowType>(this.detailRequest ? [this.detailRequest as RowType] : []);
    }
    if (statement.includes('FROM saas_requests AS r')) return result<RowType>(this.requestRows as RowType[]);
    throw new Error(`Unexpected query: ${statement}`);
  }
}

function service(database = new RecordingDatabase()): SaasConsoleUsageQueryService {
  return new SaasConsoleUsageQueryService(database);
}

function isConsoleError(code: string) {
  return (error: unknown): boolean => error instanceof SaasConsoleQueryError && error.code === code;
}

test('denies cross-tenant and project-member access in SQL', async () => {
  const database = new RecordingDatabase();
  database.allowProjectMembership = false;
  const queries = service(database);

  const crossTenant = await queries.listRequests({
    userId: 'user-other',
    tenantId: 'tenant-a',
    projectId: 'project-a',
  });
  assert.deepEqual(crossTenant.items, []);

  const projectDenied = await queries.listRequests({
    userId: 'user-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
  });
  assert.deepEqual(projectDenied.items, []);
  assert.equal(database.calls.length, 2);
  for (const call of database.calls) {
    assert.match(call.sql, /saas_memberships/);
    assert.match(call.sql, /tm\.user_id = \$1/);
    assert.match(call.sql, /tm\.status = 'active'/);
    assert.match(call.sql, /saas_project_memberships/);
    assert.match(call.sql, /pm\.user_id = \$1/);
    assert.match(call.sql, /pm\.status = 'active'/);
  }
});

test('uses bounded filters and a deterministic opaque request cursor', async () => {
  const database = new RecordingDatabase();
  database.requestRows = [
    requestRow('request-c', '2026-09-28T03:00:00.000Z'),
    requestRow('request-b', '2026-09-28T02:00:00.000Z'),
    requestRow('request-a', '2026-09-28T01:00:00.000Z'),
  ];
  const queries = service(database);
  const input = {
    userId: 'user-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    model: 'model-a',
    status: 'succeeded' as const,
    supplyMode: 'platform' as const,
    from: '2026-09-27T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
    limit: 2,
  };
  const firstPage = await queries.listRequests(input);
  assert.deepEqual(
    firstPage.items.map((item: ConsoleRequest) => item.id),
    ['request-c', 'request-b'],
  );
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor?.startsWith('c1.'));
  assert.match(database.calls[0]?.sql ?? '', /ORDER BY r\.created_at DESC, r\.id DESC/);
  assert.equal(database.calls[0]?.values.at(-1), 3);

  database.requestRows = [];
  const secondPage = await queries.listRequests({ ...input, cursor: firstPage.nextCursor });
  assert.deepEqual(secondPage.items, []);
  assert.match(database.calls[1]?.sql ?? '', /\(r\.created_at, r\.id\) < \(\$/);

  await assert.rejects(queries.listRequests({ ...input, limit: 101 }), isConsoleError('CONSOLE_INVALID_INPUT'));
  await assert.rejects(
    queries.listRequests({ ...input, status: 'settled' as never }),
    isConsoleError('CONSOLE_INVALID_INPUT'),
  );
  await assert.rejects(
    queries.listRequests({
      ...input,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-03-01T00:00:00.000Z',
    }),
    isConsoleError('CONSOLE_INVALID_INPUT'),
  );
  await assert.rejects(
    queries.listRequests({ ...input, cursor: 'not-a-cursor' }),
    isConsoleError('CONSOLE_INVALID_INPUT'),
  );
});

test('returns safe request detail projections and exact decimal-string usage totals', async () => {
  const database = new RecordingDatabase();
  database.attemptRows = [
    {
      attempt_id: 'attempt-a',
      sequence: 1,
      status: 'succeeded',
      response_started: true,
      response_started_at: '2026-09-28T01:00:01.000Z',
      http_status: 200,
      created_at: '2026-09-28T01:00:00.000Z',
      updated_at: '2026-09-28T01:00:01.000Z',
    },
  ];
  database.usageRows = [
    {
      usage_id: 'usage-a',
      supply_mode: 'platform',
      input_total: '900719925474099312345',
      input_uncached: null,
      cache_read: '3',
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      output_total: '55',
      reasoning_output: '5',
      status: 'reported',
      source: 'upstream',
      measurement_kind: 'snapshot',
      billable_basis: 'exact',
      created_at: '2026-09-28T01:00:02.000Z',
    },
  ];
  const queries = service(database);
  const detail = await queries.getRequest({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestId: 'request-a',
  });
  assert.equal(detail?.usageEvents[0]?.inputTotal, '900719925474099312345');
  assert.equal(detail?.attempts[0]?.httpStatus, 200);
  const serialized = JSON.stringify(detail).toLowerCase();
  for (const forbidden of [
    'prompt',
    'completion',
    'body',
    'credential',
    'account_id',
    'upstream_id',
    'resolved_model',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `unexpected field ${forbidden}`);
  }
  for (const call of database.calls) {
    assert.doesNotMatch(
      call.sql,
      /prompt|completion|body|credential|account_id|idempotency|upstream_id|resolved_model/i,
    );
  }

  const summary = await queries.getUsageSummary({
    userId: 'user-a',
    tenantId: 'tenant-a',
    from: '2026-09-27T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
  });
  assert.equal(summary?.inputTotal, '900719925474099312345');
  assert.equal(summary?.totalTokens, '900719925474099312400');
  assert.equal(typeof summary?.inputTotal, 'string');
  assert.match(database.calls.at(-1)?.sql ?? '', /::text/);

  const buckets = await queries.listUsageSummaries({
    userId: 'user-a',
    tenantId: 'tenant-a',
    from: '2026-09-27T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
    limit: 1,
  });
  assert.equal((buckets.items[0] as ConsoleUsageSummaryBucket | undefined)?.inputTotal, '900719925474099312345');
  assert.equal(typeof buckets.items[0]?.totalTokens, 'string');
  assert.match(database.calls.at(-1)?.sql ?? '', /saas_memberships/);
});

test('fails closed on database errors and does not return partial data', async () => {
  const database = new RecordingDatabase();
  database.fail = true;
  const queries = service(database);
  await assert.rejects(
    queries.listRequests({ userId: 'user-a', tenantId: 'tenant-a' }),
    (error: unknown) =>
      error instanceof SaasConsoleQueryError &&
      error.code === 'CONSOLE_STORAGE_ERROR' &&
      error.message === 'The console query could not be completed.',
  );
});

test('request list and detail expose persisted execution, financial and reconciliation axes independently', async () => {
  const database = new RecordingDatabase();
  const base = requestRow('request-a', '2026-09-28T01:00:00.000Z');
  const cases = [
    { supply_mode: 'platform', status: 'succeeded', financial_status: 'reconciliation_pending', reconciliation_state: 'resolved' },
    { supply_mode: 'platform', status: 'succeeded', financial_status: 'settled', reconciliation_state: 'resolved' },
    { supply_mode: 'platform', status: 'failed', financial_status: 'released', reconciliation_state: 'none' },
    { supply_mode: 'platform', status: 'pending', financial_status: 'pending', reconciliation_state: 'none' },
    { supply_mode: 'platform', status: 'unknown', financial_status: 'pending', reconciliation_state: 'pending' },
    { supply_mode: 'byok', status: 'succeeded', financial_status: 'not_applicable', reconciliation_state: 'resolved' },
    { supply_mode: 'byok', status: 'unknown', financial_status: 'not_applicable', reconciliation_state: 'pending' },
  ];
  const queries = service(database);
  for (const states of cases) {
    // Unexpected database columns are not part of the customer projection.
    const row = { ...base, ...states, proxy_key_id: 'internal-key', usage_evidence_ref: 'internal-evidence' };
    database.requestRows = [row];
    database.detailRequest = row;
    const page = await queries.listRequests({ userId: 'user-a', tenantId: 'tenant-a', projectId: 'project-a' });
    const detail = await queries.getRequest({ userId: 'user-a', tenantId: 'tenant-a', requestId: 'request-a', projectId: 'project-a' });
    assert.ok(detail);
    for (const projected of [page.items[0], detail]) {
      assert.equal(projected?.status, states.status);
      assert.equal(projected?.financialStatus, states.financial_status);
      assert.equal(projected?.reconciliationState, states.reconciliation_state);
      assert.equal(JSON.stringify(projected).includes('internal-'), false);
    }
  }
  const requestCalls = database.calls.filter((call) => call.sql.includes('FROM saas_requests AS r'));
  for (const call of requestCalls) {
    assert.match(call.sql, /r\.financial_status AS financial_status/);
    assert.match(call.sql, /r\.reconciliation_state AS reconciliation_state/);
    assert.match(call.sql, /r\.tenant_id = \$2/);
    assert.match(call.sql, /tm\.user_id = \$1/);
    assert.match(call.sql, /pm\.user_id = \$1/);
    assert.doesNotMatch(call.sql, /SELECT\s+\*|saas_wallets|saas_billing_reservations|saas_ledger|proxy_key_id|usage_evidence_ref/i);
  }
});

test('invalid or missing stored axes fail closed without inferred financial approval', async () => {
  const invalidStates: Row[] = [
    { financial_status: undefined },
    { financial_status: null },
    { financial_status: 'future-status' },
    { reconciliation_state: undefined },
    { reconciliation_state: null },
    { reconciliation_state: 'future-state' },
    { supply_mode: 'byok', financial_status: 'settled' },
    { supply_mode: 'platform', financial_status: 'not_applicable' },
    { status: 'unknown', reconciliation_state: 'resolved' },
    { status: 'unknown', reconciliation_state: 'none' },
  ];
  for (const invalidState of invalidStates) {
    const database = new RecordingDatabase();
    const row = { ...requestRow('request-a', '2026-09-28T01:00:00.000Z'), ...invalidState };
    database.requestRows = [row];
    database.detailRequest = row;
    const queries = service(database);
    await assert.rejects(
      queries.listRequests({ userId: 'user-a', tenantId: 'tenant-a', projectId: 'project-a' }),
      isConsoleError('CONSOLE_STORAGE_ERROR'),
    );
    await assert.rejects(
      queries.getRequest({ userId: 'user-a', tenantId: 'tenant-a', requestId: 'request-a', projectId: 'project-a' }),
      isConsoleError('CONSOLE_STORAGE_ERROR'),
    );
  }
});

test('adding financial metadata does not expand cross-tenant or revoked-project detail access', async () => {
  const database = new RecordingDatabase();
  const queries = service(database);
  const otherTenant = await queries.getRequest({ userId: 'user-a', tenantId: 'tenant-other', requestId: 'request-a' });
  assert.equal(otherTenant, null);
  assert.equal(database.calls.length, 1);
  database.allowProjectMembership = false;
  const revoked = await queries.getRequest({ userId: 'user-a', tenantId: 'tenant-a', requestId: 'request-a', projectId: 'project-a' });
  assert.equal(revoked, null);
  assert.equal(database.calls.length, 2);
  for (const call of database.calls) {
    assert.match(call.sql, /r\.id = \$3/);
    assert.match(call.sql, /tm\.status = 'active'/);
    assert.match(call.sql, /pm\.status = 'active'/);
  }
});
