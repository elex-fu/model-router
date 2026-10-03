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
  assert.doesNotMatch(firstCall.sql, /api_key\.created|credential|secret|body|detail|before|after|password/i);
  assert.doesNotMatch(firstCall.sql, /a\.source_ip|SELECT\s+a\.user_agent/);

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

function operatorMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    audience: 'platform',
    actor_kind: 'trusted_operator',
    workload_id: 'saas:platform-mfa-enroll',
    database_role: 'model_router_saas_control_plane',
    operator_id: 'ops:handoff-01',
    reason_code: 'initial-enrollment',
    outcome: 'issued',
    ...overrides,
  });
}

function operatorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return auditRow(ID_A, '2026-09-30T16:00:00.000Z', {
    tenant_id: null,
    actor_user_id: null,
    action: 'platform_mfa.enrollment_token.issued',
    target_type: 'platform_mfa_enrollment_user',
    target_id: ACTOR_ID,
    entry_point: 'trusted_operator_cli:platform_mfa_enroll',
    operator_attestation_metadata: operatorMetadata(),
    ...overrides,
  });
}

test('projects only bounded declared MFA operator metadata and redacts email-digest denial targets', async () => {
  const database = new FakeAuditExecutor();
  const digest = 'd'.repeat(64);
  database.enqueue([
    operatorRow({ source_ip: '192.0.2.5', user_agent: 'raw-UA-secret', details: { token: 'payload-secret' } }),
    operatorRow({
      id: ID_B,
      action: 'platform_mfa.enrollment_token.denied',
      target_type: 'platform_mfa_enrollment_email_digest',
      target_id: digest,
      operator_attestation_metadata: operatorMetadata({ reason_code: 'approved-enrollment', outcome: 'target-unavailable' }),
    }),
    ...['target-unavailable', 'verified-totp-present', 'enrollment-pending'].map(outcome => operatorRow({
      action: 'platform_mfa.enrollment_token.denied',
      operator_attestation_metadata: operatorMetadata({ operator_id: 'o'.repeat(96), outcome }),
    })),
  ]);
  const page = await new PlatformAuditHistoryQueryService(database, CURSOR_SECRET).list({ limit: 10 });
  assert.deepEqual(page.items[0]?.operatorAttestation, {
    operatorId: 'ops:handoff-01', reasonCode: 'initial-enrollment', outcome: 'issued',
  });
  assert.equal(page.items[0]?.actorId, null);
  assert.equal(page.items[0]?.entityId, ACTOR_ID);
  assert.deepEqual(page.items[1]?.operatorAttestation, {
    operatorId: 'ops:handoff-01', reasonCode: 'approved-enrollment', outcome: 'target-unavailable',
  });
  assert.equal(page.items[1]?.entityId, null);
  assert.equal(page.items.slice(2).every(event => event.operatorAttestation?.operatorId.length === 96), true);
  assert.doesNotMatch(JSON.stringify(page), /raw-UA-secret|payload-secret|192\.0\.2\.5|audience|actor_kind|workload_id|database_role|user_agent|source_ip/);
  assert.equal(JSON.stringify(page).includes(digest), false);
  const sql = database.calls[0]?.sql ?? '';
  assert.match(sql, /CASE WHEN a\.tenant_id IS NULL AND a\.actor_user_id IS NULL/);
  assert.match(sql, /a\.action IN \('platform_mfa\.enrollment_token\.issued', 'platform_mfa\.enrollment_token\.denied'\)/);
  assert.match(sql, /a\.entry_point = 'trusted_operator_cli:platform_mfa_enroll'/);
  assert.match(sql, /octet_length\(a\.user_agent\) <= 1024\s+THEN a\.user_agent ELSE NULL END AS operator_attestation_metadata/);
  assert.doesNotMatch(sql, /::json|jsonb_/); // Bound the SQL read before application deserialization.
});

test('omits malformed, oversize, forged, unrelated and prototype-bearing operator metadata without dropping safe rows', async () => {
  const raw = operatorMetadata();
  const badMetadata: unknown[] = [
    undefined, null, {}, [], 42, '', '{', 'null', '[]', '"user-agent"',
    raw + 'x', ' '.repeat(1025) + raw, raw + '界'.repeat(400),
    operatorMetadata({ audience: 'customer' }),
    operatorMetadata({ actor_kind: 'platform_user' }),
    operatorMetadata({ workload_id: 'saas:bootstrap-admin' }),
    operatorMetadata({ database_role: 'model_router_saas_gateway' }),
    operatorMetadata({ database_role: 'model_router_saas_migrator' }),
    operatorMetadata({ operator_id: '' }),
    operatorMetadata({ operator_id: 'o'.repeat(97) }),
    operatorMetadata({ operator_id: '运维' }),
    operatorMetadata({ operator_id: 'ops\nforged' }),
    operatorMetadata({ operator_id: '<img src=x onerror=alert(1)>' }),
    operatorMetadata({ reason_code: 'unknown-reason' }),
    operatorMetadata({ outcome: 'unknown' }),
    operatorMetadata({ outcome: 'enrollment-pending' }),
    operatorMetadata({ token: 'must-not-leak-token' }),
    operatorMetadata({ email_digest: 'must-not-leak-email-digest' }),
    operatorMetadata({ outcome: { value: 'issued' } }),
    raw.replace('"audience":', '"audience":"customer","audience":'),
    raw.replace('"audience":', '"\\u0061udience":"customer","audience":'),
    raw.replace('{', '{"__proto__":{"operator_id":"must-not-leak-proto"},'),
    raw.replace('{', '{"constructor":{"prototype":{"token":"must-not-leak-proto"}},'),
    raw.replace('"outcome":"issued"', '"unexpected":"issued"'),
  ];
  const badRows = [
    ...badMetadata.map(operator_attestation_metadata => operatorRow({ operator_attestation_metadata })),
    operatorRow({ tenant_id: TENANT_ID }),
    operatorRow({ actor_user_id: ACTOR_ID }),
    operatorRow({ entry_point: 'platform_http' }),
    operatorRow({ entry_point: 'trusted_operator_cli:platform_mfa_enroll:forged' }),
    operatorRow({ action: 'platform_mfa.enrollment_token.issued:forged' }),
    operatorRow({ action: 'api_key.created' }),
    operatorRow({ target_type: 'saas_user' }),
    operatorRow({ target_id: 'not-a-user-uuid' }),
    operatorRow({ action: 'platform_mfa.enrollment_token.denied' }),
    operatorRow({ target_type: 'platform_mfa_enrollment_email_digest', target_id: 'd'.repeat(64) }),
    operatorRow({
      action: 'platform_mfa.enrollment_token.denied', target_type: 'platform_mfa_enrollment_email_digest',
      target_id: 'd'.repeat(64), operator_attestation_metadata: operatorMetadata({ outcome: 'enrollment-pending' }),
    }),
  ];
  const database = new FakeAuditExecutor();
  database.enqueue(badRows);
  const page = await new PlatformAuditHistoryQueryService(database, CURSOR_SECRET).list({ limit: 100 });
  assert.equal(page.items.length, badRows.length);
  for (const event of page.items) {
    assert.equal(Object.hasOwn(event, 'operatorAttestation'), false);
    if (event.entityType === 'platform_mfa_enrollment_email_digest') assert.equal(event.entityId, null);
  }
  assert.doesNotMatch(JSON.stringify(page), /must-not-leak|onerror|operator_id|user_agent|__proto__|constructor/);
  assert.equal(Object.hasOwn(Object.prototype, 'operator_id'), false);
});

test('adding an operator projection leaves actor UUID predicates, cursor binding and old safe records unchanged', async () => {
  const database = new FakeAuditExecutor();
  database.enqueue([
    operatorRow(),
    auditRow(ID_B, '2026-09-01T00:00:00.000Z', { user_agent: operatorMetadata() }),
  ]);
  const service = new PlatformAuditHistoryQueryService(database, CURSOR_SECRET);
  const page = await service.list({ actorId: ACTOR_ID, limit: 1 });
  assert.match(database.calls[0]?.sql ?? '', /WHERE a\.actor_user_id = \$1/);
  assert.deepEqual(database.calls[0]?.values, [ACTOR_ID, 2]);
  assert.ok(page.nextCursor);
  await assert.rejects(service.list({ actorId: TENANT_ID, cursor: page.nextCursor }), isError('AUDIT_INVALID_INPUT'));
  await assert.rejects(service.list({ operatorId: 'ops:handoff-01' } as never), isError('AUDIT_INVALID_INPUT'));
  assert.equal(database.calls.length, 1);

  database.enqueue([auditRow(ID_B, '2026-09-01T00:00:00.000Z', { user_agent: operatorMetadata() })]);
  const legacy = await service.list();
  assert.equal(legacy.items[0]?.actorId, ACTOR_ID);
  assert.equal(Object.hasOwn(legacy.items[0] ?? {}, 'operatorAttestation'), false);
});
