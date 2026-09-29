import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresUnknownOutcomeOperatorAuthorizationAdapter } from '../../../src/saas/metering/postgres-unknown-outcome-operator-authorization.js';

interface AuthorizationState {
  readonly actorDisabled: boolean;
  readonly actorAnonymized: boolean;
  readonly sessionExpired: boolean;
  readonly sessionRevoked: boolean;
  readonly roleActive: boolean;
}

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class RecordingExecutor implements SqlExecutor {
  readonly calls: QueryCall[] = [];
  throwOnAuthorizationRead = false;

  constructor(private readonly state: AuthorizationState) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, values });
    if (this.throwOnAuthorizationRead && sql.includes('FROM saas_users')) {
      throw new Error('database unavailable');
    }
    if (sql.includes('FROM saas_users')) {
      const authorized =
        !this.state.actorDisabled &&
        !this.state.actorAnonymized &&
        !this.state.sessionExpired &&
        !this.state.sessionRevoked &&
        this.state.roleActive;
      return {
        rows: (authorized ? [{ authorized: 1 }] : []) as Row[],
        rowCount: authorized ? 1 : 0,
      };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

const INPUT = {
  tenantId: 'tenant-a',
  actorUserId: 'operator-a',
  actorSessionId: 'session-a',
} as const;

const AUTHORIZED: AuthorizationState = {
  actorDisabled: false,
  actorAnonymized: false,
  sessionExpired: false,
  sessionRevoked: false,
  roleActive: true,
};

test('transaction recheck fences and reads authorization on the supplied executor in order', async () => {
  const poolExecutor = new RecordingExecutor(AUTHORIZED);
  const transactionExecutor = new RecordingExecutor(AUTHORIZED);
  const adapter = new PostgresUnknownOutcomeOperatorAuthorizationAdapter(poolExecutor);

  assert.equal(await adapter.revalidateMayResolveUnknownOutcome({ executor: transactionExecutor, ...INPUT }), true);
  assert.equal(poolExecutor.calls.length, 0, 'transaction recheck must not use the pool executor');
  assert.equal(transactionExecutor.calls.length, 3);
  assert.match(transactionExecutor.calls[0]?.sql ?? '', /SET TRANSACTION ISOLATION LEVEL READ COMMITTED/);
  assert.match(
    transactionExecutor.calls[1]?.sql ?? '',
    /pg_advisory_xact_lock_shared\(hashtextextended\(\$1::text, 0\)\)/,
  );
  assert.deepEqual(transactionExecutor.calls[1]?.values, ['operator-a']);
  assert.match(transactionExecutor.calls[2]?.sql ?? '', /FROM saas_users/);
  assert.match(transactionExecutor.calls[2]?.sql ?? '', /saas_platform_sessions/);
  assert.match(transactionExecutor.calls[2]?.sql ?? '', /saas_platform_role_assignments/);
  assert.doesNotMatch(transactionExecutor.calls[2]?.sql ?? '', /FOR SHARE/i);
  assert.deepEqual(transactionExecutor.calls[2]?.values, ['operator-a', 'session-a']);
});

test('expired or revoked sessions, disabled or anonymized actors, and revoked roles fail closed', async (t) => {
  const scenarios: readonly [string, Partial<AuthorizationState>][] = [
    ['expired session', { sessionExpired: true }],
    ['revoked session', { sessionRevoked: true }],
    ['disabled actor', { actorDisabled: true }],
    ['anonymized actor', { actorAnonymized: true }],
    ['revoked operations/superadmin role', { roleActive: false }],
  ];

  for (const [name, overrides] of scenarios) {
    await t.test(name, async () => {
      const state = { ...AUTHORIZED, ...overrides };
      const poolExecutor = new RecordingExecutor(state);
      const transactionExecutor = new RecordingExecutor(state);
      const adapter = new PostgresUnknownOutcomeOperatorAuthorizationAdapter(poolExecutor);

      assert.equal(await adapter.mayResolveUnknownOutcome(INPUT), false);
      assert.equal(
        await adapter.revalidateMayResolveUnknownOutcome({ executor: transactionExecutor, ...INPUT }),
        false,
      );
      assert.equal(poolExecutor.calls.length, 1);
      assert.equal(transactionExecutor.calls.length, 3);
    });
  }
});

test('database errors fail closed for both preflight and transaction recheck', async () => {
  const poolExecutor = new RecordingExecutor(AUTHORIZED);
  const transactionExecutor = new RecordingExecutor(AUTHORIZED);
  poolExecutor.throwOnAuthorizationRead = true;
  transactionExecutor.throwOnAuthorizationRead = true;
  const adapter = new PostgresUnknownOutcomeOperatorAuthorizationAdapter(poolExecutor);

  assert.equal(await adapter.mayResolveUnknownOutcome(INPUT), false);
  assert.equal(await adapter.revalidateMayResolveUnknownOutcome({ executor: transactionExecutor, ...INPUT }), false);
});
