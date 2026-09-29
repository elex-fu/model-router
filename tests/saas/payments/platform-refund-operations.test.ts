import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { createPlatformPaymentRefundOperations } from '../../../src/saas/payments/platform-refund-operations.js';

const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000006';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ORDER_ID = '00000000-0000-4000-8000-000000000003';

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

interface FakeAuthority {
  readonly sessionId: string | null;
  readonly roles: readonly unknown[];
}

function authorityExecutor(
  authority: FakeAuthority,
  statements: Array<{ sql: string; values: readonly unknown[] }>,
  failLock = false,
): SqlExecutor {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values: [...values] });
      if (normalized.startsWith('SELECT pg_advisory_xact_lock_shared')) {
        if (failLock) throw new Error('advisory lock timeout');
        return result<Row>();
      }
      if (normalized.startsWith('SELECT s.id AS session_id')) {
        if (values[0] !== authority.sessionId || values[1] !== ACTOR_ID || authority.sessionId === null) {
          return result<Row>();
        }
        return result<Row>([{ session_id: authority.sessionId, roles: [...authority.roles] } as Row]);
      }
      return result<Row>();
    },
  };
}

function authorizationInput(
  overrides: Partial<{ sessionId: string | null; actorRoles: readonly string[] | null }> = {},
) {
  return {
    actorId: ACTOR_ID,
    sessionId: overrides.sessionId === undefined ? SESSION_ID : overrides.sessionId,
    actorRoles: overrides.actorRoles === undefined ? ['finance'] : overrides.actorRoles,
    tenantId: TENANT_ID,
    originalOrderId: ORDER_ID,
    refundType: 'wallet_topup' as const,
    amountMinorUnits: '1250',
  };
}

test('refund authorization fences a plain active-session, MFA, and exact-role-set recheck', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const executor = authorityExecutor({ sessionId: SESSION_ID, roles: ['finance'] }, statements);
  const operations = createPlatformPaymentRefundOperations({ idFactory: () => 'authorization-ref-1' });
  const authorization = await operations.authorize(authorizationInput(), executor);

  assert.equal(authorization.authorizationRef, 'authorization-ref-1');
  assert.match(statements[0]?.sql ?? '', /^SET LOCAL lock_timeout/);
  assert.match(statements[1]?.sql ?? '', /^SET LOCAL statement_timeout/);
  assert.match(statements[2]?.sql ?? '', /pg_advisory_xact_lock_shared\(hashtextextended\(\$1::text, 0\)\)/);
  assert.deepEqual(statements[2]?.values, [ACTOR_ID]);
  assert.match(statements[3]?.sql ?? '', /FROM saas_platform_sessions s/);
  assert.match(statements[3]?.sql ?? '', /s\.id = \$1 AND s\.user_id = \$2/);
  assert.match(statements[3]?.sql ?? '', /s\.expires_at > clock_timestamp\(\)/);
  assert.match(statements[3]?.sql ?? '', /u\.disabled_at IS NULL/);
  assert.match(statements[3]?.sql ?? '', /u\.anonymized_at IS NULL/);
  assert.match(statements[3]?.sql ?? '', /c\.verified_at IS NOT NULL AND c\.revoked_at IS NULL/);
  assert.match(statements[3]?.sql ?? '', /array_agg\(r\.role ORDER BY r\.role\)/);
  assert.doesNotMatch(statements[3]?.sql ?? '', /FOR\s+(?:NO KEY )?(?:KEY SHARE|SHARE|UPDATE)/i);
  assert.deepEqual(statements[3]?.values, [SESSION_ID, ACTOR_ID]);

  const superadmin = await operations.authorize(
    authorizationInput({ actorRoles: ['superadmin'] }),
    authorityExecutor({ sessionId: SESSION_ID, roles: ['superadmin'] }, []),
  );
  assert.equal(superadmin.authorizationRef, 'authorization-ref-1');
});

test('refund authorization fails closed for stale session or role snapshots', async (t) => {
  const operations = createPlatformPaymentRefundOperations();
  const cases: Array<{ name: string; authority: FakeAuthority; actorRoles: readonly string[] }> = [
    { name: 'revoked or missing session', authority: { sessionId: null, roles: ['finance'] }, actorRoles: ['finance'] },
    { name: 'role removed', authority: { sessionId: SESSION_ID, roles: [] }, actorRoles: ['finance'] },
    {
      name: 'role set changed',
      authority: { sessionId: SESSION_ID, roles: ['finance', 'operations'] },
      actorRoles: ['finance'],
    },
    {
      name: 'unknown role added',
      authority: { sessionId: SESSION_ID, roles: ['finance', 'root'] },
      actorRoles: ['finance', 'root'],
    },
    {
      name: 'unauthorized role',
      authority: { sessionId: SESSION_ID, roles: ['security'] },
      actorRoles: ['security'],
    },
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      await assert.rejects(
        operations.authorize(
          authorizationInput({ actorRoles: example.actorRoles }),
          authorityExecutor(example.authority, []),
        ),
        (error: unknown) => error instanceof PaymentError && error.code === 'REFUND_FORBIDDEN',
      );
    });
  }

  await assert.rejects(
    operations.authorize(
      authorizationInput({ sessionId: null }),
      authorityExecutor({ sessionId: SESSION_ID, roles: ['finance'] }, []),
    ),
    (error: unknown) => error instanceof PaymentError && error.code === 'REFUND_FORBIDDEN',
  );
});

test('refund authorization lock errors abort before authority is read', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const operations = createPlatformPaymentRefundOperations();
  await assert.rejects(
    operations.authorize(
      authorizationInput(),
      authorityExecutor({ sessionId: SESSION_ID, roles: ['finance'] }, statements, true),
    ),
    /advisory lock timeout/,
  );
  assert.equal(
    statements.some(({ sql }) => sql.startsWith('SELECT s.id AS session_id')),
    false,
  );
});

test('refund audit is appended through the transaction executor and links to the refund row', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const executor = authorityExecutor({ sessionId: SESSION_ID, roles: ['finance'] }, statements);
  const operations = createPlatformPaymentRefundOperations({ idFactory: () => 'audit-event-1' });
  await operations.recordAudit(executor, {
    actorId: ACTOR_ID,
    tenantId: TENANT_ID,
    action: 'payment.refund.requested',
    refundId: '00000000-0000-4000-8000-000000000004',
    originalOrderId: ORDER_ID,
    amountMinorUnits: '1250',
    currency: 'USD',
    status: 'submitting',
    reasonCode: 'OPERATOR_APPROVED',
  });
  assert.match(statements[0]?.sql ?? '', /INSERT INTO saas_audit_events/);
  assert.match(statements[0]?.sql ?? '', /saas_payment_refund/);
  assert.match(statements[0]?.sql ?? '', /platform_payments/);
  assert.equal(statements[0]?.values[4], '00000000-0000-4000-8000-000000000004');
});
