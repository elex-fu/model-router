import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import type { ApiKeyMetadata, CreateApiKeyInput, SupplyProfileResolution } from '../../../src/saas/keys/types.js';

interface StoredKey {
  id: string;
  tenant_id: string;
  project_id: string;
  principal_user_id: string | null;
  execution_principal_type: 'member' | 'project_service';
  execution_principal_id: string;
  created_by_user_id: string;
  rotated_by_user_id: string | null;
  revoked_by_user_id: string | null;
  entitlement_id: string | null;
  supply_profile_id: string;
  supply_mode: 'byok' | 'platform';
  name: string;
  prefix: string;
  key_hash: string;
  model_scopes: string[];
  status: 'active' | 'revoked';
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  authz_version: number;
  model_scope_version: number;
  entitlement_authz_version: number | null;
  supply_profile_authz_version: number | null;
}

interface AuditRow {
  action: string;
  targetId: string;
  tenantId: string;
  actorUserId: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows: clone(rows), rowCount: rows.length };
}

class FakeKeyDatabase implements SaasDatabase {
  readonly keys: StoredKey[] = [];
  readonly audits: AuditRow[] = [];
  readonly statements: string[] = [];
  readonly advisoryFenceKeys: string[] = [];
  readonly memberships = new Map<string, { tenantRole: string; projectRole: string; status: string }>([
    ['user-1', { tenantRole: 'owner', projectRole: 'owner', status: 'active' }],
    ['user-2', { tenantRole: 'admin', projectRole: 'developer', status: 'active' }],
  ]);
  failAudit = false;
  failAuthenticationLookup = false;
  authenticationLookupCount = 0;
  readonly disabledUsers = new Set<string>();
  authorizationFenceHook: ((sql: string, values: readonly unknown[]) => void) | undefined;
  statementTimestamp = new Date('2026-09-28T00:00:00.000Z');
  transactionActive = false;
  tenantStatus = 'active';
  projectPolicyStatus = 'active';
  entitlementStatus = 'active';
  providerRightAvailable = true;
  raceKeyOnLock = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const keysBefore = clone(this.keys);
    const auditsBefore = clone(this.audits);
    this.transactionActive = true;
    try {
      return await work(this);
    } catch (error) {
      this.keys.splice(0, this.keys.length, ...keysBefore);
      this.audits.splice(0, this.audits.length, ...auditsBefore);
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  async migrate(): Promise<void> {}

  async verifySchema(): Promise<void> {}

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  setMembershipRoles(userId: string, tenantRole: string, projectRole: string, status = 'active'): void {
    this.memberships.set(userId, { tenantRole, projectRole, status });
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    this.statements.push(sql);
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t] = values;

    if (statement.startsWith('select pg_advisory_xact_lock_shared')) {
      this.advisoryFenceKeys.push(String(values[0]));
      this.authorizationFenceHook?.(sql, values);
      return result<Row>();
    }
    if (statement.startsWith('select pg_advisory_xact_lock(')) {
      this.advisoryFenceKeys.push(String(values[0]));
      this.authorizationFenceHook?.(sql, values);
      return result<Row>();
    }

    if (statement.includes('from saas_tenants')) {
      return result<Row>([{ id: String(a), status: this.tenantStatus } as Row]);
    }
    if (statement.includes('from saas_projects')) {
      return result<Row>([
        {
          tenant_id: String(a),
          id: String(b),
          inference_policy_version: '1',
          inference_policy_status: this.projectPolicyStatus,
        } as Row,
      ]);
    }
    if (statement.includes('from saas_project_inference_policy_versions')) {
      return result<Row>([
        {
          tenant_id: String(a),
          project_id: String(b),
          version: String(c),
          status: this.projectPolicyStatus,
        } as Row,
      ]);
    }
    if (statement.includes('from saas_users')) {
      const ids = (a as readonly string[]).map(String);
      return result<Row>(
        ids.map(
          (id) =>
            ({
              id,
              disabled_at: this.disabledUsers.has(id) ? this.statementTimestamp : null,
              anonymized_at: null,
            }) as Row,
        ),
      );
    }
    if (statement.includes('from saas_memberships')) {
      const ids = (b as readonly string[]).map(String);
      return result<Row>(
        ids.map((userId) => {
          const membership = this.memberships.get(userId) ?? {
            tenantRole: 'owner',
            projectRole: 'owner',
            status: 'active',
          };
          return {
            tenant_id: String(a),
            user_id: userId,
            role: membership.tenantRole,
            status: membership.status,
            revoked_at: membership.status === 'active' ? null : this.statementTimestamp,
          } as Row;
        }),
      );
    }
    if (statement.includes('from saas_project_memberships')) {
      const ids = (c as readonly string[]).map(String);
      return result<Row>(
        ids.map((userId) => {
          const membership = this.memberships.get(userId) ?? {
            tenantRole: 'owner',
            projectRole: 'owner',
            status: 'active',
          };
          return {
            tenant_id: String(a),
            project_id: String(b),
            user_id: userId,
            role: membership.projectRole,
            status: membership.status,
            revoked_at: membership.status === 'active' ? null : this.statementTimestamp,
          } as Row;
        }),
      );
    }
    if (statement.includes('from saas_project_entitlements')) {
      const entitlementId = String(c);
      const platform = entitlementId.includes('platform');
      const entitlementVersion = platform ? 7 : 3;
      const profileVersion = platform ? 8 : 5;
      const modelScopes = platform ? ['model-a'] : ['model-a', 'model-b'];
      return result<Row>([
        {
          entitlement_id: entitlementId,
          entitlement_tenant_id: String(a),
          entitlement_project_id: String(b),
          entitlement_status: this.entitlementStatus,
          entitlement_profile_id: String(d),
          entitlement_supply_mode: platform ? 'platform' : 'byok',
          entitlement_model_scopes: modelScopes,
          entitlement_authz_version: entitlementVersion,
          entitlement_effective_at: '2026-09-27T00:00:00.000Z',
          entitlement_expires_at: null,
          entitlement_superseded_at: null,
          profile_id: String(d),
          profile_tenant_id: String(a),
          profile_status: 'active',
          profile_supply_mode: platform ? 'platform' : 'byok',
          profile_model_scopes: modelScopes,
          profile_authz_version: profileVersion,
        } as Row,
      ]);
    }
    if (statement.startsWith('select distinct pool.id')) {
      return result<Row>(this.providerRightAvailable ? ([{ pool_id: 'pool-a' }] as Row[]) : []);
    }
    if (statement.includes('from saas_route_config_heads')) {
      return result<Row>(
        this.providerRightAvailable
          ? [
              {
                rights_id: `rights-${String(c)}`,
                version: 1,
                effective_at: '2026-09-27T00:00:00.000Z',
                expires_at: null,
              } as Row,
            ]
          : [],
      );
    }
    if (statement.includes('clock_timestamp()')) {
      return result<Row>([{ now: this.statementTimestamp } as Row]);
    }

    if (statement.startsWith('insert into saas_api_keys')) {
      const isRotationInsert = values.length === 20;
      const row: StoredKey = {
        id: String(a),
        tenant_id: String(b),
        project_id: String(c),
        principal_user_id: d === null || d === undefined ? null : String(d),
        execution_principal_type: e as 'member' | 'project_service',
        execution_principal_id: String(f),
        created_by_user_id: String(g),
        rotated_by_user_id: null,
        revoked_by_user_id: null,
        entitlement_id: h === null || h === undefined ? null : String(h),
        supply_profile_id: String(i),
        supply_mode: j as 'byok' | 'platform',
        name: String(k),
        prefix: String(l),
        key_hash: String(m),
        model_scopes: [...(n as string[])],
        status: 'active',
        created_at: new Date(String(o)),
        expires_at: p === null || p === undefined ? null : new Date(String(p)),
        revoked_at: null,
        last_used_at: null,
        authz_version: isRotationInsert ? Number(q) : 1,
        model_scope_version: Number(isRotationInsert ? r : q),
        entitlement_authz_version:
          (isRotationInsert ? s : r) === null || (isRotationInsert ? s : r) === undefined
            ? null
            : Number(isRotationInsert ? s : r),
        supply_profile_authz_version:
          (isRotationInsert ? t : s) === null || (isRotationInsert ? t : s) === undefined
            ? null
            : Number(isRotationInsert ? t : s),
      };
      this.keys.push(row);
      return result<Row>([this.view(row) as Row]);
    }

    if (statement.startsWith('insert into saas_audit_events')) {
      if (this.failAudit) throw new Error('injected audit failure');
      this.audits.push({
        action: String(d),
        targetId: String(e),
        tenantId: String(b),
        actorUserId: String(c),
      });
      return result<Row>();
    }

    if (statement.startsWith('select id, tenant_id, project_id, principal_user_id')) {
      if (statement.includes('where key_hash =')) {
        this.authenticationLookupCount += 1;
        if (this.failAuthenticationLookup) throw new Error('injected key lookup failure');
        if (!statement.includes("status = 'active'") || !statement.includes('expires_at > statement_timestamp()')) {
          throw new Error('Authentication lookup omitted its active/unexpired predicate');
        }
        const row = this.keys.find(
          (candidate) =>
            candidate.key_hash === String(a) &&
            candidate.status === 'active' &&
            (candidate.expires_at === null || candidate.expires_at.getTime() > this.statementTimestamp.getTime()),
        );
        return result<Row>(row ? [this.view(row) as Row] : []);
      }
      if (statement.includes('where id =')) {
        if (this.raceKeyOnLock && statement.includes('for update')) {
          this.raceKeyOnLock = false;
          const raceTarget = this.keys.find((candidate) => candidate.id === String(a));
          if (raceTarget) raceTarget.entitlement_authz_version = (raceTarget.entitlement_authz_version ?? 0) + 1;
        }
        const row = this.keys.find(
          (candidate) =>
            candidate.id === String(a) && candidate.tenant_id === String(b) && candidate.project_id === String(c),
        );
        return result<Row>(row ? [this.view(row) as Row] : []);
      }
      const rows = this.keys
        .filter((row) => row.tenant_id === String(a) && row.project_id === String(b))
        .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
        .map((row) => this.view(row) as Row);
      return result<Row>(rows);
    }

    if (statement.startsWith('update saas_api_keys')) {
      const row = this.keys.find(
        (candidate) =>
          candidate.id === String(a) &&
          candidate.tenant_id === String(b) &&
          candidate.project_id === String(c) &&
          candidate.status === 'active',
      );
      if (!row) return result<Row>();
      row.status = 'revoked';
      row.revoked_at = new Date(String(d));
      row.authz_version = Number(e);
      row.revoked_by_user_id = f === undefined || f === null ? null : String(f);
      if (statement.includes('rotated_by_user_id')) row.rotated_by_user_id = row.revoked_by_user_id;
      return result<Row>([this.view(row) as Row]);
    }

    throw new Error(`Unimplemented fake SQL: ${statement}`);
  }

  private view(row: StoredKey): Omit<StoredKey, 'key_hash'> {
    const { key_hash: _keyHash, ...safe } = clone(row);
    return safe;
  }
}

const baseContext: TenantContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  tenantRole: 'owner',
  projectRole: 'owner',
};

function resolver(resolution: SupplyProfileResolution | null) {
  return { resolve: async () => resolution };
}

const byokResolution: SupplyProfileResolution = {
  entitlementId: 'entitlement-byok-1',
  profileId: 'profile-byok-1',
  mode: 'byok',
  allowedModels: ['model-a', 'model-b'],
  entitlementAuthzVersion: 3,
  supplyProfileAuthzVersion: 5,
  modelScopeVersion: 5,
};

const baseInput: CreateApiKeyInput = {
  name: 'Console key',
  modelScopes: ['model-a'],
  supplyMode: 'byok',
  principalKind: 'member',
};

async function expectKeyError(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

test('create stores only a SHA-256 digest, returns a 256-bit secret once, and lists safe active metadata', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });

  const created = await service.create(baseContext, baseInput);
  assert.match(created.secret, /^mr_live_[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(created.secret.slice('mr_live_'.length), 'base64url').byteLength, 32);
  assert.equal(created.supplyProfileId, 'profile-byok-1');
  assert.equal(created.supplyMode, 'byok');
  assert.equal(database.keys.length, 1);
  assert.equal(database.keys[0]?.key_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.equal(JSON.stringify(database.keys).includes(created.secret), false);
  assert.equal(JSON.stringify(database.keys).includes('secret'), false);

  const listed = await service.list(baseContext);
  assert.equal(listed.length, 1);
  const { secret: _secret, ...createdMetadata } = created;
  assert.deepEqual(listed[0], createdMetadata);
  assert.equal((listed[0] as ApiKeyMetadata & { secret?: string }).secret, undefined);
  assert.equal(JSON.stringify(listed).includes(created.secret), false);
  assert.equal(JSON.stringify(listed).includes('key_hash'), false);
});

test('authentication resolves an issued raw key to safe metadata and its stored authorization snapshot', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  const authenticated = await service.authenticate(created.secret);

  assert.ok(authenticated);
  const { secret: _secret, ...expectedMetadata } = created;
  assert.deepEqual(authenticated.metadata, expectedMetadata);
  assert.deepEqual(authenticated.authorization, {
    keyId: created.id,
    tenantId: baseContext.tenantId,
    projectId: baseContext.projectId,
    principalKind: 'member',
    principalId: baseContext.userId,
    entitlementId: byokResolution.entitlementId,
    supplyProfileId: byokResolution.profileId,
    supplyMode: 'byok',
    modelScopes: ['model-a'],
    authzVersion: 1,
    modelScopeVersion: byokResolution.modelScopeVersion,
    entitlementAuthzVersion: byokResolution.entitlementAuthzVersion,
    supplyProfileAuthzVersion: byokResolution.supplyProfileAuthzVersion,
  });
  const serialized = JSON.stringify(authenticated);
  assert.equal(serialized.includes(created.secret), false);
  assert.equal(serialized.includes(database.keys[0]?.key_hash ?? ''), false);
  assert.equal(serialized.includes('key_hash'), false);
  assert.equal(database.authenticationLookupCount, 1);
});

test('authentication fails closed for an unknown key, revoked keys, and expired keys', async () => {
  const database = new FakeKeyDatabase();
  const now = new Date('2026-09-28T00:00:00.000Z');
  const service = new KeyService(database, { resolver: resolver(byokResolution), now: () => now });
  const created = await service.create(baseContext, baseInput);
  const firstSecretIndex = 'mr_live_'.length;
  const replacementCharacter = created.secret[firstSecretIndex] === 'A' ? 'B' : 'A';
  const wrongKey =
    created.secret.slice(0, firstSecretIndex) + replacementCharacter + created.secret.slice(firstSecretIndex + 1);
  assert.equal(await service.authenticate(wrongKey), null);

  await service.revoke(baseContext, created.id);
  assert.equal(await service.authenticate(created.secret), null);

  const expiring = await service.create(baseContext, {
    ...baseInput,
    expiresAt: '2026-09-28T00:05:00.000Z',
  });
  database.statementTimestamp = new Date('2026-09-28T00:05:00.000Z');
  assert.equal(await service.authenticate(expiring.secret), null);
  assert.equal(database.authenticationLookupCount, 3);
});

test('malformed or missing authentication input does not query the key store', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database);

  for (const rawKey of [undefined, null, '', 'mr_live_too-short', `mr_live_${'a'.repeat(42)}`, 'other_prefix']) {
    assert.equal(await service.authenticate(rawKey), null);
  }
  assert.equal(database.authenticationLookupCount, 0);
});

test('authentication database failures remain generic storage errors', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  const created = await service.create(baseContext, baseInput);
  database.failAuthenticationLookup = true;

  await assert.rejects(service.authenticate(created.secret), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'KEY_STORAGE_ERROR');
    assert.equal((error as { status?: number }).status, 500);
    assert.equal((error as Error).message, 'The API key service could not complete the request');
    assert.equal((error as Error).message.includes(created.secret), false);
    return true;
  });
});

test('missing, empty, or unauthorized entitlements fail closed and scopes cannot widen them', async () => {
  const missing = new KeyService(new FakeKeyDatabase());
  await expectKeyError(() => missing.create(baseContext, baseInput), 'KEY_SUPPLY_UNAVAILABLE');

  const noEntitlement = new KeyService(new FakeKeyDatabase(), { resolver: resolver(null) });
  await expectKeyError(() => noEntitlement.create(baseContext, baseInput), 'KEY_NO_ENTITLEMENT');

  const emptyEntitlement = new KeyService(new FakeKeyDatabase(), {
    resolver: resolver({
      entitlementId: 'entitlement-empty',
      profileId: 'profile-empty',
      mode: 'platform',
      allowedModels: [],
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    }),
  });
  await expectKeyError(() => emptyEntitlement.create(baseContext, baseInput), 'KEY_PROFILE_INVALID');

  const restricted = new KeyService(new FakeKeyDatabase(), { resolver: resolver(byokResolution) });
  await expectKeyError(
    () => restricted.create(baseContext, { ...baseInput, name: 'Too broad', modelScopes: ['model-c'] }),
    'KEY_SCOPE_NOT_ALLOWED',
  );
  await expectKeyError(
    () => restricted.create(baseContext, { ...baseInput, name: 'Unrestricted', modelScopes: [] }),
    'KEY_INVALID_INPUT',
  );
  await expectKeyError(
    () => restricted.create(baseContext, { ...baseInput, name: 'Unrestricted', modelScopes: undefined as never }),
    'KEY_INVALID_INPUT',
  );
});

test('the requested mode selects the resolver-owned profile and entitlement', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: {
      resolve: async (_context, mode) =>
        mode === 'byok'
          ? byokResolution
          : {
              entitlementId: 'entitlement-platform-1',
              profileId: 'profile-platform-1',
              mode: 'platform',
              allowedModels: ['model-a'],
              entitlementAuthzVersion: 7,
              supplyProfileAuthzVersion: 8,
              modelScopeVersion: 8,
            },
    },
  });

  const byok = await service.create(baseContext, {
    ...baseInput,
    ...({ supplyProfileId: 'client-forged', entitlementId: 'client-forged' } as Record<string, unknown>),
  } as CreateApiKeyInput);
  const platform = await service.create(baseContext, { ...baseInput, supplyMode: 'platform' });

  assert.equal(byok.supplyMode, 'byok');
  assert.equal(byok.entitlementId, 'entitlement-byok-1');
  assert.equal(byok.supplyProfileId, 'profile-byok-1');
  assert.equal(platform.supplyMode, 'platform');
  assert.equal(platform.entitlementId, 'entitlement-platform-1');
  assert.equal(platform.supplyProfileId, 'profile-platform-1');
});

test('project-service keys bind execution to the authorized project and retain the creator separately', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  const created = await service.create(baseContext, {
    ...baseInput,
    principalKind: 'project_service',
    ...({ principalId: 'attacker-controlled-user' } as Record<string, unknown>),
  } as CreateApiKeyInput);

  assert.equal(created.executionPrincipalType, 'project_service');
  assert.equal(created.executionPrincipalId, baseContext.projectId);
  assert.equal(created.principalUserId, null);
  assert.equal(created.createdByUserId, baseContext.userId);
  assert.equal(database.keys[0]?.execution_principal_id, baseContext.projectId);
  assert.equal(database.keys[0]?.principal_user_id, null);
  assert.equal(database.keys[0]?.created_by_user_id, baseContext.userId);
  assert.equal(created.entitlementAuthzVersion, byokResolution.entitlementAuthzVersion);
  assert.equal(created.supplyProfileAuthzVersion, byokResolution.supplyProfileAuthzVersion);
  assert.equal(created.modelScopeVersion, byokResolution.modelScopeVersion);
});

test('invalid resolver authorization versions fail closed before a key is written', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver({
      ...byokResolution,
      entitlementAuthzVersion: 0,
    }),
  });
  await expectKeyError(() => service.create(baseContext, baseInput), 'KEY_PROFILE_INVALID');
  assert.equal(database.keys.length, 0);
});

test('create resolves, locks, and validates scopes on the transaction executor', async () => {
  const database = new FakeKeyDatabase();
  let observed: { mode: string; executor: SqlExecutor | undefined; inTransaction: boolean } | undefined;
  const service = new KeyService(database, {
    resolver: {
      resolve: async (_context, mode, options) => {
        observed = { mode, executor: options?.executor, inTransaction: database.transactionActive };
        return byokResolution;
      },
    },
  });

  await expectKeyError(
    () => service.create(baseContext, { ...baseInput, modelScopes: ['model-not-entitled'] }),
    'KEY_SCOPE_NOT_ALLOWED',
  );
  assert.deepEqual(observed, { mode: 'byok', executor: database, inTransaction: true });
  assert.equal(database.keys.length, 0);
});

test('rechecks current membership and user state after simulated fence waits (fake SQL)', async () => {
  const revokedMembership = new FakeKeyDatabase();
  let membershipRevoked = false;
  revokedMembership.authorizationFenceHook = (_sql, values) => {
    if (!membershipRevoked && values[0] === 'saas-authz:tenant:tenant-1') {
      membershipRevoked = true;
      revokedMembership.setMembershipRoles(baseContext.userId, 'owner', 'owner', 'revoked');
    }
  };
  await expectKeyError(
    () => new KeyService(revokedMembership, { resolver: resolver(byokResolution) }).create(baseContext, baseInput),
    'KEY_ACCESS_DENIED',
  );
  assert.equal(revokedMembership.keys.length, 0);

  const disabledUser = new FakeKeyDatabase();
  let userDisabled = false;
  disabledUser.authorizationFenceHook = (_sql, values) => {
    if (!userDisabled && values[0] === baseContext.userId) {
      userDisabled = true;
      disabledUser.disabledUsers.add(baseContext.userId);
    }
  };
  await expectKeyError(
    () => new KeyService(disabledUser, { resolver: resolver(byokResolution) }).create(baseContext, baseInput),
    'KEY_ACCESS_DENIED',
  );
  assert.equal(disabledUser.keys.length, 0);
});

test('rechecks entitlement and provider-rights state after simulated fence waits (fake SQL)', async () => {
  const revokedEntitlement = new FakeKeyDatabase();
  let entitlementRevoked = false;
  revokedEntitlement.authorizationFenceHook = (_sql, values) => {
    if (!entitlementRevoked && values[0] === 'saas-authz:project:tenant-1:project-1') {
      entitlementRevoked = true;
      revokedEntitlement.entitlementStatus = 'disabled';
    }
  };
  await expectKeyError(
    () => new KeyService(revokedEntitlement, { resolver: resolver(byokResolution) }).create(baseContext, baseInput),
    'KEY_NO_ENTITLEMENT',
  );
  assert.equal(revokedEntitlement.keys.length, 0);

  const revokedRights = new FakeKeyDatabase();
  let rightsRevoked = false;
  revokedRights.authorizationFenceHook = (_sql, values) => {
    if (!rightsRevoked && values[0] === 'saas-authz:provider-rights') {
      rightsRevoked = true;
      revokedRights.providerRightAvailable = false;
    }
  };
  await expectKeyError(
    () => new KeyService(revokedRights, { resolver: resolver(byokResolution) }).create(baseContext, baseInput),
    'KEY_SCOPE_NOT_ALLOWED',
  );
  assert.equal(revokedRights.keys.length, 0);
});

test('rotation re-resolves the stored entitlement and mode instead of selecting a new binding', async () => {
  const database = new FakeKeyDatabase();
  const calls: Array<{ mode: string; entitlementId: string | undefined; inTransaction: boolean }> = [];
  const service = new KeyService(database, {
    resolver: {
      resolve: async (_context, mode, options) => {
        calls.push({ mode, entitlementId: options?.entitlementId, inTransaction: database.transactionActive });
        return byokResolution;
      },
    },
  });
  const original = await service.create(baseContext, baseInput);
  calls.length = 0;

  const replacement = await service.rotate(baseContext, original.id);
  assert.equal(replacement.entitlementId, 'entitlement-byok-1');
  assert.equal(replacement.supplyProfileId, 'profile-byok-1');
  assert.equal(replacement.supplyMode, 'byok');
  assert.deepEqual(calls, [{ mode: 'byok', entitlementId: 'entitlement-byok-1', inTransaction: true }]);
});

test('legacy null-entitlement keys cannot rotate but can still be revoked', async () => {
  const database = new FakeKeyDatabase();
  database.keys.push({
    id: 'legacy-key',
    tenant_id: baseContext.tenantId,
    project_id: baseContext.projectId,
    principal_user_id: baseContext.userId,
    execution_principal_type: 'member',
    execution_principal_id: baseContext.userId,
    created_by_user_id: baseContext.userId,
    rotated_by_user_id: null,
    revoked_by_user_id: null,
    entitlement_id: null,
    supply_profile_id: 'legacy-profile',
    supply_mode: 'byok',
    name: 'Legacy key',
    prefix: 'mr_live_legacy01',
    key_hash: 'a'.repeat(64),
    model_scopes: ['model-a'],
    status: 'active',
    created_at: new Date('2026-09-28T00:00:00.000Z'),
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    authz_version: 1,
    model_scope_version: 1,
    entitlement_authz_version: null,
    supply_profile_authz_version: null,
  });
  let resolverCalls = 0;
  const service = new KeyService(database, {
    resolver: {
      resolve: async () => {
        resolverCalls += 1;
        return byokResolution;
      },
    },
  });

  await expectKeyError(() => service.rotate(baseContext, 'legacy-key'), 'KEY_NO_ENTITLEMENT');
  assert.equal(resolverCalls, 0);
  const revoked = await service.revoke(baseContext, 'legacy-key');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.entitlementId, null);
});

test('both tenant and project roles must be management roles', async () => {
  const allowed: Array<[TenantContext['tenantRole'], TenantContext['projectRole']]> = [
    ['owner', 'owner'],
    ['admin', 'developer'],
    ['developer', 'admin'],
  ];
  for (const [tenantRole, projectRole] of allowed) {
    const database = new FakeKeyDatabase();
    database.setMembershipRoles(baseContext.userId, tenantRole, projectRole);
    const service = new KeyService(database, { resolver: resolver(byokResolution) });
    const created = await service.create(baseContext, { ...baseInput, name: `${tenantRole}-${projectRole}` });
    assert.equal(created.status, 'active');
  }

  const denied: Array<[TenantContext['tenantRole'], TenantContext['projectRole']]> = [
    ['billing', 'owner'],
    ['owner', 'billing'],
    ['viewer', 'owner'],
    ['owner', 'viewer'],
  ];
  for (const [tenantRole, projectRole] of denied) {
    const service = new KeyService(new FakeKeyDatabase(), { resolver: resolver(byokResolution) });
    const context = { ...baseContext, tenantRole, projectRole };
    await expectKeyError(() => service.list(context), 'KEY_ACCESS_DENIED');
    await expectKeyError(() => service.create(context, baseInput), 'KEY_ACCESS_DENIED');
  }
});

test('project-service issuance requires current owner/admin roles at both tenant and project scope', async () => {
  const serviceInput = { ...baseInput, principalKind: 'project_service' as const };
  const allowed: Array<[string, string]> = [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['owner', 'admin'],
    ['admin', 'owner'],
  ];
  for (const [tenantRole, projectRole] of allowed) {
    const database = new FakeKeyDatabase();
    database.setMembershipRoles(baseContext.userId, tenantRole, projectRole);
    const service = new KeyService(database, { resolver: resolver(byokResolution) });
    const created = await service.create(baseContext, serviceInput);
    assert.equal(created.executionPrincipalType, 'project_service');
  }

  const denied: Array<[string, string]> = [
    ['developer', 'owner'],
    ['owner', 'developer'],
    ['admin', 'viewer'],
  ];
  for (const [tenantRole, projectRole] of denied) {
    const database = new FakeKeyDatabase();
    database.setMembershipRoles(baseContext.userId, tenantRole, projectRole);
    const service = new KeyService(database, { resolver: resolver(byokResolution) });
    await expectKeyError(() => service.create(baseContext, serviceInput), 'KEY_ACCESS_DENIED');
    assert.equal(database.keys.length, 0);
  }
});

test('project-service rotation depends on the current operator and project policy, not the creator membership', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  const original = await service.create(baseContext, { ...baseInput, principalKind: 'project_service' });

  database.setMembershipRoles(baseContext.userId, 'viewer', 'viewer', 'revoked');
  database.setMembershipRoles('user-2', 'admin', 'admin');
  const rotatingContext: TenantContext = {
    ...baseContext,
    userId: 'user-2',
    tenantRole: 'admin',
    projectRole: 'admin',
  };
  const replacement = await service.rotate(rotatingContext, original.id);
  assert.equal(replacement.executionPrincipalType, 'project_service');
  assert.equal(replacement.executionPrincipalId, baseContext.projectId);
  assert.equal(replacement.principalUserId, null);
  assert.equal(replacement.createdByUserId, rotatingContext.userId);
  assert.equal(database.keys.find((key) => key.id === original.id)?.status, 'revoked');

  database.projectPolicyStatus = 'suspended';
  await expectKeyError(() => service.rotate(rotatingContext, replacement.id), 'KEY_ACCESS_DENIED');
  assert.equal(database.keys.find((key) => key.id === replacement.id)?.status, 'active');
});

test('member-bound rotation rechecks the execution member and rolls back a binding race', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  const original = await service.create(baseContext, baseInput);
  database.setMembershipRoles(baseContext.userId, 'developer', 'developer', 'revoked');
  database.setMembershipRoles('user-2', 'admin', 'admin');
  const rotatingContext: TenantContext = {
    ...baseContext,
    userId: 'user-2',
    tenantRole: 'admin',
    projectRole: 'admin',
  };
  await expectKeyError(() => service.rotate(rotatingContext, original.id), 'KEY_ACCESS_DENIED');
  assert.equal(database.keys[0]?.status, 'active');

  database.setMembershipRoles(baseContext.userId, 'developer', 'developer');
  database.raceKeyOnLock = true;
  await expectKeyError(() => service.rotate(rotatingContext, original.id), 'KEY_NO_ENTITLEMENT');
  assert.equal(database.keys[0]?.status, 'active');
});

test('key issuance requires active tenant/project policy and current provider-right route coverage', async () => {
  const suspended = new FakeKeyDatabase();
  suspended.projectPolicyStatus = 'suspended';
  const suspendedService = new KeyService(suspended, { resolver: resolver(byokResolution) });
  await expectKeyError(() => suspendedService.create(baseContext, baseInput), 'KEY_ACCESS_DENIED');

  const noRights = new FakeKeyDatabase();
  noRights.providerRightAvailable = false;
  const noRightsService = new KeyService(noRights, { resolver: resolver(byokResolution) });
  await expectKeyError(() => noRightsService.create(baseContext, baseInput), 'KEY_SCOPE_NOT_ALLOWED');
  assert.equal(noRights.keys.length, 0);

  const issued = new FakeKeyDatabase();
  await new KeyService(issued, { resolver: resolver(byokResolution) }).create(baseContext, baseInput);
  const projectHeadSql = issued.statements.find((sql) => /FROM saas_projects/i.test(sql)) ?? '';
  const policyVersionSql =
    issued.statements.find((sql) => /FROM saas_project_inference_policy_versions/i.test(sql)) ?? '';
  assert.equal(issued.advisoryFenceKeys[0], 'saas-authz:tenant:tenant-1');
  assert.equal(issued.advisoryFenceKeys[1], 'saas-authz:project:tenant-1:project-1');
  const apiKeyFence = issued.advisoryFenceKeys.find((key) => key.startsWith('saas-authz:api-key:'));
  assert.match(
    apiKeyFence ?? '',
    new RegExp(
      `^saas-authz:api-key:${Buffer.from(baseContext.tenantId, 'utf8').toString('hex')}:${Buffer.from(
        baseContext.projectId,
        'utf8',
      ).toString('hex')}:[0-9a-f]+$`,
    ),
  );
  assert.match(projectHeadSql, /tenant_id = \$1 AND id = \$2/i);
  assert.doesNotMatch(projectHeadSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  assert.match(policyVersionSql, /tenant_id = \$1 AND project_id = \$2 AND version = \$3/i);
  assert.doesNotMatch(policyVersionSql, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  const routeQuery = issued.statements.find((sql) => /FROM saas_route_config_heads/i.test(sql)) ?? '';
  assert.doesNotMatch(routeQuery, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
  const entitlementQuery = issued.statements.find((sql) => /FROM saas_project_entitlements/i.test(sql)) ?? '';
  assert.doesNotMatch(entitlementQuery, /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i);
});

test('tenant/project selectors cannot cross boundaries, and revoke is idempotent with versioned audit', async () => {
  let now = new Date('2026-09-28T00:00:00.000Z');
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution), now: () => now });
  const created = await service.create(baseContext, baseInput);

  const otherContext = { ...baseContext, tenantId: 'tenant-2' };
  assert.deepEqual(await service.list(otherContext), []);
  await expectKeyError(() => service.revoke(otherContext, created.id), 'KEY_NOT_FOUND');
  await expectKeyError(() => service.rotate(otherContext, created.id), 'KEY_NOT_FOUND');
  assert.equal(database.keys[0]?.status, 'active');

  database.setMembershipRoles(baseContext.userId, 'owner', 'owner', 'revoked');
  await expectKeyError(() => service.revoke(baseContext, created.id), 'KEY_ACCESS_DENIED');
  assert.equal(database.keys[0]?.status, 'active');
  database.setMembershipRoles(baseContext.userId, 'owner', 'owner');

  now = new Date('2026-09-28T00:01:00.000Z');
  const revoked = await service.revoke(baseContext, created.id);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.authzVersion, 2);
  assert.equal(revoked.revokedByUserId, baseContext.userId);
  assert.equal(database.audits.filter((audit) => audit.action === 'api_key.revoked').length, 1);
  const revokeRowLockIndex = database.statements.findIndex(
    (sql) => sql.includes('FROM saas_api_keys') && sql.includes('FOR UPDATE'),
  );
  const lastRevokeFenceIndex = database.statements.reduce(
    (index, sql, current) => (sql.toLowerCase().startsWith('select pg_advisory_xact_lock') ? current : index),
    -1,
  );
  assert.ok(lastRevokeFenceIndex >= 0 && revokeRowLockIndex > lastRevokeFenceIndex);
  const history = await service.list(baseContext);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.id, created.id);
  assert.equal(history[0]?.status, 'revoked');
  assert.equal(JSON.stringify(history).includes(created.secret), false);
  assert.equal(JSON.stringify(history).includes('key_hash'), false);

  const repeated = await service.revoke(baseContext, created.id);
  assert.deepEqual(repeated, revoked);
  assert.equal(database.audits.filter((audit) => audit.action === 'api_key.revoked').length, 1);
});

test('rotate revokes the old key and creates a fixed-scope replacement atomically', async () => {
  let now = new Date('2026-09-28T00:00:00.000Z');
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution), now: () => now });
  const original = await service.create(baseContext, baseInput);
  now = new Date('2026-09-28T00:02:00.000Z');

  const rotatingContext = { ...baseContext, userId: 'user-2' };
  const rotateStatementStart = database.statements.length;
  const replacement = await service.rotate(rotatingContext, original.id);
  assert.notEqual(replacement.id, original.id);
  assert.notEqual(replacement.secret, original.secret);
  assert.equal(replacement.supplyProfileId, original.supplyProfileId);
  assert.deepEqual(replacement.modelScopes, original.modelScopes);
  assert.equal(replacement.authzVersion, 2);
  assert.equal(database.keys.find((key) => key.id === original.id)?.status, 'revoked');
  assert.equal(database.keys.find((key) => key.id === original.id)?.authz_version, 2);
  assert.equal(database.keys.find((key) => key.id === original.id)?.rotated_by_user_id, rotatingContext.userId);
  assert.equal(database.keys.find((key) => key.id === original.id)?.principal_user_id, baseContext.userId);
  assert.equal(database.keys.find((key) => key.id === replacement.id)?.created_by_user_id, rotatingContext.userId);
  assert.equal(database.keys.find((key) => key.id === replacement.id)?.status, 'active');
  const history = await service.list(baseContext);
  assert.equal(history.length, 2);
  assert.equal(history.find((key) => key.id === original.id)?.status, 'revoked');
  assert.equal(history.find((key) => key.id === replacement.id)?.status, 'active');
  assert.equal(JSON.stringify(history).includes(original.secret), false);
  assert.equal(JSON.stringify(history).includes(replacement.secret), false);
  assert.equal(database.audits.filter((audit) => audit.action === 'api_key.rotated').length, 1);
  const rotateStatements = database.statements.slice(rotateStatementStart);
  const rotateRowLockIndex = rotateStatements.findIndex(
    (sql) => sql.includes('FROM saas_api_keys') && sql.includes('FOR UPDATE'),
  );
  const lastRotateFenceIndex = rotateStatements
    .slice(0, rotateRowLockIndex)
    .reduce(
      (index, sql, current) => (sql.toLowerCase().startsWith('select pg_advisory_xact_lock') ? current : index),
      -1,
    );
  assert.ok(lastRotateFenceIndex >= 0 && rotateRowLockIndex > lastRotateFenceIndex);

  await expectKeyError(() => service.rotate(baseContext, original.id), 'KEY_ALREADY_REVOKED');
});

test('create and rotate audit failures roll back key state', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  database.failAudit = true;
  await expectKeyError(() => service.create(baseContext, baseInput), 'KEY_STORAGE_ERROR');
  assert.equal(database.keys.length, 0);

  database.failAudit = false;
  const original = await service.create(baseContext, baseInput);
  database.failAudit = true;
  await expectKeyError(() => service.rotate(baseContext, original.id), 'KEY_STORAGE_ERROR');
  assert.equal(database.keys.length, 1);
  assert.equal(database.keys[0]?.status, 'active');
  assert.equal(database.audits.filter((audit) => audit.action === 'api_key.rotated').length, 0);
});
