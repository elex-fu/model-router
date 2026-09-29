import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PlatformAuditHistoryQueryService,
  PlatformAuditQueryError,
} from '../../../../src/saas/platform/audit/index.js';
import { FakeAuditExecutor } from './fake-executor.js';

const CURSOR_SECRET = 'audit-history-test-secret-2026';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function auditRow(id: string, occurredAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_ID,
    actor_user_id: ACTOR_ID,
    action: 'api_key.created',
    target_type: 'saas_api_key',
    target_id: 'key-reference-1',
    occurred_at: occurredAt,
    entry_point: 'console_api_keys',
    request_id: 'request-1',
    ...overrides,
  };
}

function isError(code: PlatformAuditQueryError['code']): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof PlatformAuditQueryError && error.code === code;
}

test('returns a safe projection and uses stable bounded keyset ordering with bound filters', async () => {
  const database = new FakeAuditExecutor();
  database.enqueue(
    [
      auditRow(ID_A, '2026-09-04T00:00:00.000Z', {
        source_ip: '192.0.2.1',
        user_agent: 'secret-bearing-user-agent-must-not-leak',
        details: { password: 'must-not-leak' },
        credential_value: 'must-not-leak',
        request_body: 'must-not-leak',
        before: { apiKey: 'must-not-leak' },
        after: { secret: 'must-not-leak' },
        email: 'must-not-leak@example.test',
      }),
      auditRow(ID_B, '2026-09-03T00:00:00.000Z'),
      auditRow(ID_C, '2026-09-02T00:00:00.000Z'),
    ],
    [auditRow(ID_C, '2026-09-02T00:00:00.000Z')],
  );
  const service = new PlatformAuditHistoryQueryService(database, { cursorSecret: CURSOR_SECRET });

  const first = await service.listAuditEvents({
    actorId: ACTOR_ID,
    action: 'api_key.created',
    entityType: 'saas_api_key',
    createdFrom: '2026-09-01T00:00:00+08:00',
    createdTo: '2026-09-05T00:00:00+08:00',
    limit: 2,
  });

  assert.deepEqual(first.items, [
    {
      id: ID_A,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      action: 'api_key.created',
      entityType: 'saas_api_key',
      entityId: 'key-reference-1',
      occurredAt: '2026-09-04T00:00:00.000Z',
      entryPoint: 'console_api_keys',
      requestId: 'request-1',
    },
    {
      id: ID_B,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      action: 'api_key.created',
      entityType: 'saas_api_key',
      entityId: 'key-reference-1',
      occurredAt: '2026-09-03T00:00:00.000Z',
      entryPoint: 'console_api_keys',
      requestId: 'request-1',
    },
  ]);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor ?? '', /^pah1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);

  const firstCall = database.calls[0];
  assert.ok(firstCall);
  assert.match(firstCall.sql, /ORDER BY a\.occurred_at DESC, a\.id DESC/);
  assert.match(firstCall.sql, /LIMIT \$6/);
  assert.match(firstCall.sql, /a\.actor_user_id = \$1/);
  assert.match(firstCall.sql, /a\.action = \$2/);
  assert.match(firstCall.sql, /a\.target_type = \$3/);
  assert.deepEqual(firstCall.values, [
    ACTOR_ID,
    'api_key.created',
    'saas_api_key',
    '2026-08-31T16:00:00.000Z',
    '2026-09-04T16:00:00.000Z',
    3,
  ]);
  assert.doesNotMatch(firstCall.sql, /api_key\.created|credential|secret|body|detail|before|after|email|password/i);

  const second = await service.listEvents({
    actorId: ACTOR_ID,
    action: 'api_key.created',
    entityType: 'saas_api_key',
    createdFrom: '2026-09-01T00:00:00+08:00',
    createdTo: '2026-09-05T00:00:00+08:00',
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0]?.id, ID_C);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);

  const secondCall = database.calls[1];
  assert.ok(secondCall);
  assert.match(secondCall.sql, /\(a\.occurred_at, a\.id\) < \(\$6, \$7\)/);
  assert.deepEqual(secondCall.values, [
    ACTOR_ID,
    'api_key.created',
    'saas_api_key',
    '2026-08-31T16:00:00.000Z',
    '2026-09-04T16:00:00.000Z',
    '2026-09-03T00:00:00.000Z',
    ID_B,
    3,
  ]);

  const serialized = JSON.stringify(first);
  for (const forbidden of [
    'source_ip',
    'user_agent',
    'secret-bearing-user-agent',
    'credential_value',
    'request_body',
    'must-not-leak',
    'password',
    'email',
    'before',
    'after',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `unexpected sensitive value ${forbidden}`);
  }
});

test('binds signed cursors to normalized filters and rejects tampering before querying', async () => {
  const database = new FakeAuditExecutor();
  database.enqueue([auditRow(ID_A, '2026-09-04T00:00:00.000Z'), auditRow(ID_B, '2026-09-03T00:00:00.000Z')]);
  const service = new PlatformAuditHistoryQueryService(database, CURSOR_SECRET);
  const first = await service.list({ limit: 1 });
  assert.ok(first.nextCursor);
  assert.equal(database.calls.length, 1);

  await assert.rejects(
    service.list({ action: 'api_key.revoked', cursor: first.nextCursor }),
    isError('AUDIT_INVALID_INPUT'),
  );
  await assert.rejects(
    service.list({ limit: 1, cursor: `${first.nextCursor?.slice(0, -1)}0` }),
    isError('AUDIT_INVALID_INPUT'),
  );
  assert.equal(database.calls.length, 1);

  const sameSecretService = new PlatformAuditHistoryQueryService(database, { cursorSecret: CURSOR_SECRET });
  database.enqueue([auditRow(ID_B, '2026-09-03T00:00:00.000Z')]);
  const second = await sameSecretService.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0]?.id, ID_B);
});

test('rejects malformed UUIDs, dates, actions, ranges, pagination, and unknown keys without querying', async () => {
  const database = new FakeAuditExecutor();
  const service = new PlatformAuditHistoryQueryService(database, { cursorSecret: CURSOR_SECRET });
  const invalidInputs: Array<Record<string, unknown>> = [
    { actorId: 'not-a-uuid' },
    { actorId: `${ACTOR_ID}x` },
    { action: '' },
    { action: 'api key.created' },
    { action: 'a'.repeat(129) },
    { entityType: ' saas_api_key' },
    { createdFrom: '2026-02-30T00:00:00Z' },
    { createdFrom: '2026-09-01T00:00:00+24:00' },
    { createdFrom: '2026-09-03T00:00:00Z', createdTo: '2026-09-02T00:00:00Z' },
    { createdFrom: '2026-01-01T00:00:00Z', createdTo: '2027-01-03T00:00:00Z' },
    { limit: 0 },
    { limit: 1, pageSize: 2 },
    { limit: 1.5 },
    { sortBy: 'occurredAt' },
    { cursor: 'pah1.not-a-signed-cursor' },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(service.list(input as never), isError('AUDIT_INVALID_INPUT'));
  }
  assert.equal(database.calls.length, 0);
});

test('fails closed for malformed rows and database failures without exposing storage details', async () => {
  const malformedDatabase = new FakeAuditExecutor();
  malformedDatabase.enqueue([
    auditRow(ID_A, 'not-a-date', {
      password: 'database-row-secret',
      details: { before: 'database-row-secret' },
    }),
  ]);
  const malformedService = new PlatformAuditHistoryQueryService(malformedDatabase, {
    cursorSecret: CURSOR_SECRET,
  });
  await assert.rejects(malformedService.list(), (error: unknown) => {
    assert.ok(error instanceof PlatformAuditQueryError);
    assert.equal(error.code, 'AUDIT_STORAGE_ERROR');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'The platform audit query could not be completed.');
    assert.doesNotMatch(error.message, /secret|password|database-row/i);
    return true;
  });

  const failedDatabase = new FakeAuditExecutor();
  failedDatabase.failWith(new Error('password=do-not-leak connection failure'));
  const failedService = new PlatformAuditHistoryQueryService(failedDatabase, { cursorSecret: CURSOR_SECRET });
  await assert.rejects(failedService.list(), (error: unknown) => {
    assert.ok(error instanceof PlatformAuditQueryError);
    assert.equal(error.code, 'AUDIT_STORAGE_ERROR');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'The platform audit query could not be completed.');
    assert.doesNotMatch(error.message, /password|do-not-leak/i);
    return true;
  });
});
