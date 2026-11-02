import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../src/saas/platform/governance/errors.js';
import { UserLimitAdminService } from '../../../src/saas/risk/user-limit-admin-service.js';

const ACTOR = '10000000-0000-4000-8000-0000000000aa';
const TARGET = '10000000-0000-4000-8000-0000000000b1';
const actor: PlatformAdminActor = {
  userId: ACTOR,
  sessionId: '10000000-0000-4000-8000-0000000000c1',
  roles: ['security'],
};

interface LimitRow extends Record<string, unknown> {
  version: string;
  requests_per_minute: string | null;
  max_concurrent_requests: string | null;
  daily_token_units: string | null;
  daily_charge_minor_units: string | null;
  charge_currency: string | null;
}

class LimitAdminFake implements SqlExecutor {
  defaults: LimitRow = {
    version: '1',
    requests_per_minute: null,
    max_concurrent_requests: null,
    daily_token_units: null,
    daily_charge_minor_units: null,
    charge_currency: null,
  };
  override: LimitRow | null = null;
  readonly audits: string[] = [];

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    let rows: Record<string, unknown>[] = [];
    let rowCount = 1;
    if (sql.includes('FROM saas_platform_sessions AS s')) {
      rows = [{ id: actor.sessionId, user_id: ACTOR }];
    } else if (sql.includes('FROM saas_platform_role_assignments')) {
      rows = [{ role: 'security' }];
    } else if (sql.includes('FROM saas_user_limit_defaults') && sql.startsWith('SELECT')) {
      rows = [{ ...this.defaults }];
    } else if (sql.includes('FROM saas_user_limit_policies') && sql.startsWith('SELECT')) {
      rows = this.override ? [{ ...this.override }] : [];
    } else if (sql.includes('SELECT id FROM saas_users')) {
      rows = [{ id: TARGET }];
    } else if (sql.startsWith('UPDATE saas_user_limit_defaults')) {
      if (values[0] !== this.defaults.version) rowCount = 0;
      else {
        this.defaults = {
          version: String(BigInt(this.defaults.version) + 1n),
          requests_per_minute: values[1] as string | null,
          max_concurrent_requests: values[2] as string | null,
          daily_token_units: values[3] as string | null,
          daily_charge_minor_units: values[4] as string | null,
          charge_currency: values[5] as string | null,
        };
        rows = [{ ...this.defaults }];
      }
    } else if (sql.startsWith('INSERT INTO saas_user_limit_policies')) {
      if (this.override) rowCount = 0;
      else {
        this.override = {
          version: '1',
          requests_per_minute: values[1] as string | null,
          max_concurrent_requests: values[2] as string | null,
          daily_token_units: values[3] as string | null,
          daily_charge_minor_units: values[4] as string | null,
          charge_currency: values[5] as string | null,
        };
        rows = [{ ...this.override }];
      }
    } else if (sql.startsWith('UPDATE saas_user_limit_policies')) {
      if (!this.override || values[1] !== this.override.version) rowCount = 0;
      else {
        this.override = {
          version: String(BigInt(this.override.version) + 1n),
          requests_per_minute: values[2] as string | null,
          max_concurrent_requests: values[3] as string | null,
          daily_token_units: values[4] as string | null,
          daily_charge_minor_units: values[5] as string | null,
          charge_currency: values[6] as string | null,
        };
        rows = [{ ...this.override }];
      }
    } else if (sql.includes('INSERT INTO saas_audit_events')) {
      this.audits.push(String(values[3]));
    }
    return { rows: rows as Row[], rowCount: rows.length > 0 ? rows.length : rowCount };
  }
}

test('operator defaults and user overrides use fresh authorization, CAS and governance audit', async () => {
  const database = new LimitAdminFake();
  const service = new UserLimitAdminService(database);
  const changedDefaults = await service.updateDefaults(actor, {
    expectedVersion: '1',
    limits: { requestsPerMinute: 100, maxConcurrentRequests: 5 },
  });
  assert.equal(changedDefaults.version, '2');
  assert.equal(changedDefaults.effective.requestsPerMinute, 100n);

  const created = await service.updateUserLimits(actor, TARGET, {
    expectedVersion: '0',
    limits: { requestsPerMinute: 20 },
  });
  assert.equal(created.version, '1');
  assert.equal(created.stored.requestsPerMinute, 20n);
  assert.equal(created.effective.maxConcurrentRequests, 5n);

  const updated = await service.updateUserLimits(actor, TARGET, {
    expectedVersion: '1',
    limits: { dailyChargeMinorUnits: '500', chargeCurrency: 'USD' },
  });
  assert.equal(updated.version, '2');
  assert.equal(updated.effective.requestsPerMinute, 20n);
  assert.equal(updated.effective.dailyChargeMinorUnits, 500n);
  assert.equal(updated.effective.chargeCurrency, 'USD');
  assert.deepEqual(database.audits, [
    'platform_user_limits.default_updated',
    'platform_user_limits.updated',
    'platform_user_limits.updated',
  ]);

  await assert.rejects(
    service.updateUserLimits(actor, TARGET, { expectedVersion: '1', limits: { requestsPerMinute: 10 } }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 409,
  );
});

test('limit reads show inheritance and writes reject malformed charge pairs', async () => {
  const database = new LimitAdminFake();
  database.defaults = { ...database.defaults, requests_per_minute: '50' };
  const service = new UserLimitAdminService(database);
  const view = await service.getUserLimits(actor, TARGET);
  assert.equal(view.version, '0');
  assert.equal(view.stored.requestsPerMinute, null);
  assert.equal(view.effective.requestsPerMinute, 50n);
  await assert.rejects(
    service.updateDefaults(actor, {
      expectedVersion: '1',
      limits: { dailyChargeMinorUnits: null, chargeCurrency: 'USD' },
    }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.status === 400,
  );
});
