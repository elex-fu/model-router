import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { PostgresSupplyProfileResolver } from '../../../src/saas/keys/resolver.js';

interface ResolverRow {
  entitlement_id: string;
  tenant_id: string;
  project_id: string;
  entitlement_status: string;
  entitlement_authz_version: number | string;
  profile_id: string;
  profile_status: string;
  supply_profile_authz_version: number | string;
  supply_mode: string;
  entitlement_model_scopes: unknown;
  profile_model_scopes: unknown;
  effective_at: Date;
  expires_at: Date | null;
  superseded_at: Date | null;
}

const STATEMENT_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z');

class FakeResolverDatabase implements SqlExecutor {
  rows: ResolverRow[] = [];
  error: Error | undefined;
  authorizationFenceHook: ((sql: string, values: readonly unknown[]) => void) | undefined;
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values });
    if (this.error) throw this.error;
    if (sql.toLowerCase().includes('pg_advisory_xact_lock_shared')) {
      this.authorizationFenceHook?.(sql, values);
      return { rows: [], rowCount: 0 };
    }
    const statementTime = STATEMENT_TIMESTAMP.getTime();
    const storedEntitlement = sql.includes('e.id = $4');
    const requestedEntitlement = storedEntitlement ? String(values[3]) : undefined;
    const eligibleRows = this.rows.filter((candidate) => {
      const matchesRequestedEntitlement =
        requestedEntitlement === undefined || candidate.entitlement_id === requestedEntitlement;
      const validWindow =
        candidate.effective_at.getTime() <= statementTime &&
        (candidate.expires_at === null || candidate.expires_at.getTime() > statementTime);
      const validStatus =
        candidate.entitlement_status === 'active' ||
        (storedEntitlement &&
          candidate.entitlement_status === 'superseded' &&
          candidate.superseded_at !== null &&
          candidate.superseded_at.getTime() <= statementTime);
      return matchesRequestedEntitlement && validWindow && validStatus && candidate.profile_status === 'active';
    });
    return {
      rows: eligibleRows as unknown as Row[],
      rowCount: eligibleRows.length,
    };
  }
}

const context: TenantContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  tenantRole: 'owner',
  projectRole: 'owner',
};

function row(overrides: Partial<ResolverRow> = {}): ResolverRow {
  return {
    entitlement_id: 'entitlement-1',
    tenant_id: context.tenantId,
    project_id: context.projectId,
    entitlement_status: 'active',
    entitlement_authz_version: 3,
    profile_id: 'profile-1',
    profile_status: 'active',
    supply_profile_authz_version: 5,
    supply_mode: 'platform',
    entitlement_model_scopes: ['model-a', 'model-b'],
    profile_model_scopes: ['model-a'],
    effective_at: new Date('2025-12-31T23:59:59.000Z'),
    expires_at: null,
    superseded_at: null,
    ...overrides,
  };
}

async function expectCode(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    assert.equal((error as { status?: number }).status, 503);
    return true;
  });
}

test('resolves the unique active entitlement and intersects it with the active profile scope (fake SQL)', async () => {
  const database = new FakeResolverDatabase();
  database.rows = [row()];

  const resolution = await new PostgresSupplyProfileResolver(database).resolve(context, 'platform', {
    executor: database,
  });

  assert.deepEqual(resolution, {
    entitlementId: 'entitlement-1',
    profileId: 'profile-1',
    mode: 'platform',
    allowedModels: ['model-a'],
    entitlementAuthzVersion: 3,
    supplyProfileAuthzVersion: 5,
    modelScopeVersion: 5,
  });
  assert.equal(database.calls.length, 3);
  assert.match(database.calls[0]?.sql ?? '', /saas-authz:tenant:/i);
  assert.deepEqual(database.calls[0]?.values, ['tenant-1']);
  assert.match(database.calls[1]?.sql ?? '', /saas-authz:project:/i);
  assert.deepEqual(database.calls[1]?.values, ['tenant-1', 'project-1']);
  const authorityQuery = database.calls[2];
  assert.deepEqual(authorityQuery?.values, ['tenant-1', 'project-1', 'platform']);
  assert.match(authorityQuery?.sql ?? '', /e\.tenant_id = \$1/i);
  assert.match(authorityQuery?.sql ?? '', /e\.project_id = \$2/i);
  assert.match(authorityQuery?.sql ?? '', /e\.supply_mode = \$3/i);
  assert.match(authorityQuery?.sql ?? '', /e\.status = 'active'/i);
  assert.match(authorityQuery?.sql ?? '', /e\.effective_at <= statement_timestamp\(\)/i);
  assert.match(
    authorityQuery?.sql ?? '',
    /\(\s*e\.expires_at IS NULL\s+OR\s+e\.expires_at > statement_timestamp\(\)\s*\)/i,
  );
  assert.match(authorityQuery?.sql ?? '', /p\.status = 'active'/i);
  assert.doesNotMatch(authorityQuery?.sql ?? '', /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('rechecks entitlement state after a simulated revocation fence wait (fake SQL)', async () => {
  const database = new FakeResolverDatabase();
  database.rows = [row()];
  database.authorizationFenceHook = (sql) => {
    if (sql.includes('saas-authz:tenant:')) {
      database.rows = [row({ entitlement_status: 'disabled' })];
      database.authorizationFenceHook = undefined;
    }
  };

  assert.equal(
    await new PostgresSupplyProfileResolver(database).resolve(context, 'platform', { executor: database }),
    null,
  );
  assert.equal(database.calls.length, 3);
  assert.match(database.calls.at(-1)?.sql ?? '', /FROM saas_project_entitlements/i);
});

test('does not grant an active entitlement outside its validity window', async () => {
  const future = new FakeResolverDatabase();
  future.rows = [row({ effective_at: new Date('2026-01-01T00:00:01.000Z') })];
  assert.equal(await new PostgresSupplyProfileResolver(future).resolve(context, 'platform'), null);

  const expired = new FakeResolverDatabase();
  expired.rows = [row({ expires_at: new Date('2026-01-01T00:00:00.000Z') })];
  assert.equal(await new PostgresSupplyProfileResolver(expired).resolve(context, 'platform'), null);

  const startsAtBoundary = new FakeResolverDatabase();
  startsAtBoundary.rows = [row({ effective_at: new Date('2026-01-01T00:00:00.000Z') })];
  assert.ok(await new PostgresSupplyProfileResolver(startsAtBoundary).resolve(context, 'platform'));
});

test('returns null when no active project entitlement/profile pair exists', async () => {
  const database = new FakeResolverDatabase();

  assert.equal(await new PostgresSupplyProfileResolver(database).resolve(context, 'platform'), null);
});

test('uses only the current active binding for new-key resolution but permits a stored superseded binding in-window', async () => {
  const database = new FakeResolverDatabase();
  database.rows = [
    row({
      entitlement_id: 'renewal-entitlement',
      entitlement_status: 'active',
      entitlement_authz_version: 8,
      profile_id: 'renewal-profile',
      supply_profile_authz_version: 9,
    }),
    row({
      entitlement_id: 'old-entitlement',
      entitlement_status: 'superseded',
      entitlement_authz_version: 4,
      profile_id: 'old-profile',
      supply_profile_authz_version: 5,
      superseded_at: new Date('2025-12-31T23:59:59.000Z'),
      expires_at: new Date('2026-01-02T00:00:00.000Z'),
    }),
  ];
  const resolver = new PostgresSupplyProfileResolver(database);

  const current = await resolver.resolve(context, 'platform');
  assert.equal(current?.entitlementId, 'renewal-entitlement');
  assert.equal(current?.entitlementAuthzVersion, 8);
  assert.equal(current?.supplyProfileAuthzVersion, 9);

  const stored = await resolver.resolve(context, 'platform', { entitlementId: 'old-entitlement' });
  assert.equal(stored?.entitlementId, 'old-entitlement');
  assert.equal(stored?.profileId, 'old-profile');
  assert.equal(stored?.entitlementAuthzVersion, 4);
  assert.equal(stored?.supplyProfileAuthzVersion, 5);
  assert.deepEqual(database.calls.at(-1)?.values, ['tenant-1', 'project-1', 'platform', 'old-entitlement']);
  assert.match(database.calls.at(-1)?.sql ?? '', /e\.status IN \('active', 'superseded'\)/i);
});

test('never resolves disabled or expired stored entitlement bindings', async () => {
  const disabled = new FakeResolverDatabase();
  disabled.rows = [row({ entitlement_status: 'disabled' })];
  assert.equal(
    await new PostgresSupplyProfileResolver(disabled).resolve(context, 'platform', {
      entitlementId: 'entitlement-1',
    }),
    null,
  );

  const expired = new FakeResolverDatabase();
  expired.rows = [
    row({
      entitlement_status: 'superseded',
      superseded_at: new Date('2025-12-31T23:59:59.000Z'),
      expires_at: new Date('2025-12-31T23:59:59.000Z'),
    }),
  ];
  assert.equal(
    await new PostgresSupplyProfileResolver(expired).resolve(context, 'platform', {
      entitlementId: 'entitlement-1',
    }),
    null,
  );
});

test('fails closed when storage or schema access fails', async () => {
  const database = new FakeResolverDatabase();
  database.error = new Error('relation saas_project_entitlements does not exist');

  await expectCode(
    () => new PostgresSupplyProfileResolver(database).resolve(context, 'platform'),
    'KEY_SUPPLY_UNAVAILABLE',
  );
});

test('fails closed for duplicate active rows, boundary mismatches, and invalid profile data', async () => {
  const duplicate = new FakeResolverDatabase();
  duplicate.rows = [row(), row({ profile_id: 'profile-2' })];
  await expectCode(
    () => new PostgresSupplyProfileResolver(duplicate).resolve(context, 'platform'),
    'KEY_PROFILE_INVALID',
  );

  const boundaryMismatch = new FakeResolverDatabase();
  boundaryMismatch.rows = [row({ tenant_id: 'tenant-2' })];
  await expectCode(
    () => new PostgresSupplyProfileResolver(boundaryMismatch).resolve(context, 'platform'),
    'KEY_PROFILE_INVALID',
  );

  const invalid = new FakeResolverDatabase();
  invalid.rows = [row({ profile_model_scopes: [' '] })];
  await expectCode(
    () => new PostgresSupplyProfileResolver(invalid).resolve(context, 'platform'),
    'KEY_PROFILE_INVALID',
  );
});

test('fails closed for missing, zero, fractional, or unsafe entitlement/profile versions', async () => {
  for (const overrides of [
    { entitlement_authz_version: 0 },
    { entitlement_authz_version: 1.5 },
    { entitlement_authz_version: Number.MAX_SAFE_INTEGER + 1 },
    { supply_profile_authz_version: 0 },
    { supply_profile_authz_version: 'not-a-version' },
  ]) {
    const database = new FakeResolverDatabase();
    database.rows = [row(overrides)];
    await expectCode(
      () => new PostgresSupplyProfileResolver(database).resolve(context, 'platform'),
      'KEY_PROFILE_INVALID',
    );
  }
});

test('rejects an active entitlement whose profile has no authorized model intersection', async () => {
  const database = new FakeResolverDatabase();
  database.rows = [row({ profile_model_scopes: ['model-c'] })];

  await expectCode(
    () => new PostgresSupplyProfileResolver(database).resolve(context, 'platform'),
    'KEY_PROFILE_INVALID',
  );
});

test('selects only the requested mode when BYOK and platform entitlements are both active', async () => {
  const database = new FakeResolverDatabase();
  database.rows = [row({ profile_id: 'profile-byok', supply_mode: 'byok', entitlement_id: 'entitlement-byok' })];

  const byok = await new PostgresSupplyProfileResolver(database).resolve(context, 'byok');
  assert.equal(byok?.entitlementId, 'entitlement-byok');
  assert.equal(byok?.mode, 'byok');
});
