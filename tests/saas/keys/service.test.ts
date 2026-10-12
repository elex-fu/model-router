import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  CUSTOMER_KEY_MUTATION_CURRENT_SQL,
  CUSTOMER_KEY_MUTATION_ISSUE_SQL,
  type CustomerKeyMutationSessionHandle,
} from '../../../src/saas/identity/customer-key-mutation-session.js';
import { revalidateCustomerKeyMutationSession, SaasIdentityService } from '../../../src/saas/identity/service.js';
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

interface StoredIpPolicy {
  tenant_id: string;
  project_id: string;
  key_id: string;
  version: string;
  mode: 'disabled' | 'allowlist' | 'denyall';
  rules: string[];
  created_at: Date;
  updated_at: Date;
}

interface StoredBudgetPolicy {
  tenant_id: string;
  project_id: string;
  key_id: string;
  lineage_id: string;
  version: string;
  token_daily: string | null;
  token_lifetime: string | null;
  charge_daily: string | null;
  charge_lifetime: string | null;
}

interface StoredBudgetCounter {
  tenant_id: string;
  project_id: string;
  lineage_id: string;
  window_kind: 'daily' | 'lifetime';
  day: string;
  token_settled: string;
  token_outstanding_reserved: string;
  charge_settled: string;
  charge_outstanding_reserved: string;
  charge_currency: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows: clone(rows), rowCount: rows.length };
}

// Independent exact protocol literals: no generic SET/advisory-prefix approval.
const WRITE_ENTRY_SQL = [
  'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  "SET LOCAL lock_timeout = '2s'",
  "SET LOCAL statement_timeout = '10s'",
  'SELECT pg_advisory_xact_lock(1396788563, 46)',
] as const;
const SHARED_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
const EXCLUSIVE_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const CUSTOMER_USER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_SESSION = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_TOKEN = 'owned_synthetic_session_token_001';
const CUSTOMER_CSRF = 'owned_synthetic_csrf_token_001';
const customerHash = (v: string) => createHash('sha256').update(v).digest('hex');

class FakeKeyDatabase implements SaasDatabase {
  readonly keys: StoredKey[] = [];
  readonly audits: AuditRow[] = [];
  readonly ipPolicies: StoredIpPolicy[] = [];
  readonly budgetPolicies: StoredBudgetPolicy[] = [];
  readonly budgetCounters: StoredBudgetCounter[] = [];
  walletCurrency: string | null = 'USD';
  readonly statements: string[] = [];
  readonly advisoryFenceKeys: string[] = [];
  readonly advisoryFences: Array<{ key: string; mode: 'shared' | 'exclusive'; statementIndex: number }> = [];
  private transactionStatementStart: number | undefined;
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
  readonly customerSession = {
    id: CUSTOMER_SESSION,
    user_id: CUSTOMER_USER,
    token_hash: customerHash(CUSTOMER_TOKEN),
    csrf_token_hash: customerHash(CUSTOMER_CSRF),
    expires_at: new Date('2030-01-01T00:00:00.000Z'),
    revoked_at: null as Date | null,
  };

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const keysBefore = clone(this.keys);
    const auditsBefore = clone(this.audits);
    const ipPoliciesBefore = clone(this.ipPolicies);
    const budgetPoliciesBefore = clone(this.budgetPolicies);
    const budgetCountersBefore = clone(this.budgetCounters);
    this.transactionActive = true;
    this.transactionStatementStart = this.statements.length;
    try {
      return await work(this);
    } catch (error) {
      this.keys.splice(0, this.keys.length, ...keysBefore);
      this.audits.splice(0, this.audits.length, ...auditsBefore);
      this.ipPolicies.splice(0, this.ipPolicies.length, ...ipPoliciesBefore);
      this.budgetPolicies.splice(0, this.budgetPolicies.length, ...budgetPoliciesBefore);
      this.budgetCounters.splice(0, this.budgetCounters.length, ...budgetCountersBefore);
      throw error;
    } finally {
      this.transactionActive = false;
      this.transactionStatementStart = undefined;
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
    const statement = normalizedSql(sql);
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t] = values;

    if (sql === CUSTOMER_KEY_MUTATION_ISSUE_SQL || sql === CUSTOMER_KEY_MUTATION_CURRENT_SQL) {
      const current = sql === CUSTOMER_KEY_MUTATION_CURRENT_SQL,
        s = this.customerSession;
      if (current && !this.transactionActive) throw new Error('Current session read outside key TX');
      const matches = current
        ? a === s.id && b === s.user_id && c === s.token_hash && d === s.csrf_token_hash
        : a === s.token_hash && b === s.csrf_token_hash;
      return result<Row>(
        matches && s.revoked_at === null && s.expires_at > this.statementTimestamp && !this.disabledUsers.has(s.user_id)
          ? [{ id: s.id, user_id: s.user_id, token_hash: s.token_hash, csrf_token_hash: s.csrf_token_hash } as Row]
          : [],
      );
    }

    const entryIndex = WRITE_ENTRY_SQL.findIndex((expected) => normalizedSql(expected) === statement);
    if (entryIndex !== -1) {
      const start = this.transactionStatementStart;
      if (
        !this.transactionActive ||
        start === undefined ||
        values.length !== 0 ||
        this.statements.length - start !== entryIndex + 1 ||
        !WRITE_ENTRY_SQL.slice(0, entryIndex).every(
          (expected, index) => normalizedSql(this.statements[start + index] ?? '') === normalizedSql(expected),
        )
      ) {
        throw new Error('Invalid fresh write transaction entry');
      }
      return result<Row>();
    }

    const fenceMode =
      statement === normalizedSql(SHARED_FENCE_SQL)
        ? 'shared'
        : statement === normalizedSql(EXCLUSIVE_FENCE_SQL)
          ? 'exclusive'
          : undefined;
    if (fenceMode !== undefined) {
      if (!this.transactionActive || values.length !== 1 || typeof values[0] !== 'string') {
        throw new Error('Invalid scoped advisory fence');
      }
      this.advisoryFenceKeys.push(values[0]);
      this.advisoryFences.push({ key: values[0], mode: fenceMode, statementIndex: this.statements.length - 1 });
      this.authorizationFenceHook?.(sql, values);
      return result<Row>();
    }

    if (
      statement.startsWith('insert into saas_api_keys') ||
      statement.startsWith('update saas_api_keys') ||
      statement.startsWith('insert into saas_api_key_ip_policies') ||
      statement.startsWith('update saas_api_key_ip_policies') ||
      statement.startsWith('insert into saas_api_key_budget_policies') ||
      statement.startsWith('update saas_api_key_budget_policies') ||
      statement.startsWith('insert into saas_audit_events')
    ) {
      const start = this.transactionStatementStart;
      if (
        !this.transactionActive ||
        start === undefined ||
        !WRITE_ENTRY_SQL.every(
          (expected, index) => normalizedSql(this.statements[start + index] ?? '') === normalizedSql(expected),
        )
      ) {
        throw new Error('Key mutation requires the complete fresh write entry');
      }
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

    if (statement.startsWith('insert into saas_api_key_ip_policies')) {
      // Create seeds a literal disabled v1 row; rotation carries mode/rules.
      const row: StoredIpPolicy = {
        tenant_id: String(a),
        project_id: String(b),
        key_id: String(c),
        version: '1',
        mode: values.length === 4 ? 'disabled' : (String(d) as StoredIpPolicy['mode']),
        rules: values.length === 4 ? [] : [...(JSON.parse(String(e)) as string[])],
        created_at: new Date(String(values.length === 4 ? d : f)),
        updated_at: new Date(String(values.length === 4 ? d : f)),
      };
      if (this.ipPolicies.some((candidate) => candidate.key_id === row.key_id)) {
        throw new Error('duplicate IP policy head');
      }
      this.ipPolicies.push(row);
      return result<Row>();
    }

    if (statement.startsWith('select tenant_id, project_id, key_id, version, mode, rules')) {
      const row = this.ipPolicies.find(
        (candidate) =>
          candidate.tenant_id === String(a) && candidate.project_id === String(b) && candidate.key_id === String(c),
      );
      return result<Row>(row ? [clone(row) as Row] : []);
    }

    if (statement.startsWith('update saas_api_key_ip_policies')) {
      const row = this.ipPolicies.find(
        (candidate) =>
          candidate.tenant_id === String(a) &&
          candidate.project_id === String(b) &&
          candidate.key_id === String(c) &&
          candidate.version === String(h),
      );
      if (!row) return result<Row>();
      row.version = String(d);
      row.mode = String(e) as StoredIpPolicy['mode'];
      row.rules = [...(JSON.parse(String(f)) as string[])];
      row.updated_at = new Date(String(g));
      return result<Row>([clone(row) as Row]);
    }

    if (statement.startsWith('insert into saas_api_key_budget_policies')) {
      // Create seeds a literal unlimited self-lineage v1 row; rotation carries
      // the predecessor lineage and caps.
      const row: StoredBudgetPolicy =
        values.length === 4
          ? {
              tenant_id: String(a),
              project_id: String(b),
              key_id: String(c),
              lineage_id: String(c),
              version: '1',
              token_daily: null,
              token_lifetime: null,
              charge_daily: null,
              charge_lifetime: null,
            }
          : {
              tenant_id: String(a),
              project_id: String(b),
              key_id: String(c),
              lineage_id: String(d),
              version: '1',
              token_daily: e === null || e === undefined ? null : String(e),
              token_lifetime: f === null || f === undefined ? null : String(f),
              charge_daily: g === null || g === undefined ? null : String(g),
              charge_lifetime: h === null || h === undefined ? null : String(h),
            };
      if (this.budgetPolicies.some((candidate) => candidate.key_id === row.key_id)) {
        throw new Error('duplicate budget policy head');
      }
      this.budgetPolicies.push(row);
      return result<Row>();
    }

    if (statement.startsWith('select tenant_id, project_id, key_id, lineage_id, version,')) {
      const row = this.budgetPolicies.find(
        (candidate) =>
          candidate.tenant_id === String(a) && candidate.project_id === String(b) && candidate.key_id === String(c),
      );
      return result<Row>(row ? [clone(row) as Row] : []);
    }

    if (statement.startsWith('update saas_api_key_budget_policies')) {
      const row = this.budgetPolicies.find(
        (candidate) =>
          candidate.tenant_id === String(a) &&
          candidate.project_id === String(b) &&
          candidate.key_id === String(c) &&
          candidate.version === String(j),
      );
      if (!row) return result<Row>();
      row.version = String(d);
      row.token_daily = e === null || e === undefined ? null : String(e);
      row.token_lifetime = f === null || f === undefined ? null : String(f);
      row.charge_daily = g === null || g === undefined ? null : String(g);
      row.charge_lifetime = h === null || h === undefined ? null : String(h);
      return result<Row>([clone(row) as Row]);
    }

    if (statement.startsWith('select window_kind, token_settled,')) {
      return result<Row>(
        this.budgetCounters
          .filter(
            (candidate) =>
              candidate.tenant_id === String(a) &&
              candidate.lineage_id === String(b) &&
              ((candidate.window_kind === 'daily' && candidate.day === String(c)) ||
                (candidate.window_kind === 'lifetime' && candidate.day === '0001-01-01')),
          )
          .map((candidate) => clone(candidate) as Row),
      );
    }

    if (statement.startsWith('select currency from saas_wallets')) {
      return result<Row>(this.walletCurrency === null ? [] : [{ currency: this.walletCurrency } as Row]);
    }

    if (statement.startsWith('select authz_version, supply_mode from saas_api_keys')) {
      const row = this.keys.find(
        (candidate) =>
          candidate.id === String(a) && candidate.tenant_id === String(b) && candidate.project_id === String(c),
      );
      return result<Row>(row ? [{ authz_version: row.authz_version, supply_mode: row.supply_mode } as Row] : []);
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

    if (statement.startsWith('select authz_version from saas_api_keys')) {
      const row = this.keys.find(
        (candidate) =>
          candidate.id === String(a) && candidate.tenant_id === String(b) && candidate.project_id === String(c),
      );
      return result<Row>(row ? [{ authz_version: row.authz_version } as Row] : []);
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
      if (!statement.includes("set status = 'revoked'")) {
        // IP policy replacement bumps only the authorization version.
        const target = this.keys.find(
          (candidate) =>
            candidate.id === String(a) && candidate.tenant_id === String(b) && candidate.project_id === String(c),
        );
        if (!target) return result<Row>();
        target.authz_version = Number(d);
        return result<Row>([{ authz_version: target.authz_version } as Row]);
      }
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

function assertWriterOrder(
  database: FakeKeyDatabase,
  statementStart: number,
  fenceStart: number,
  userIds: readonly string[],
  keyIds: readonly string[],
  providerRights: boolean,
): void {
  const statements = database.statements.slice(statementStart);
  assert.deepEqual(statements.slice(0, WRITE_ENTRY_SQL.length), [...WRITE_ENTRY_SQL]);
  const keyScopes = keyIds.map(
    (id) =>
      `saas-authz:api-key:${Buffer.from(baseContext.tenantId).toString('hex')}:${Buffer.from(baseContext.projectId).toString('hex')}:${Buffer.from(id).toString('hex')}`,
  );
  const business = [...new Set([...keyScopes, ...(providerRights ? ['saas-authz:provider-rights'] : [])])].sort();
  const expected = [
    { key: 'saas-authz:tenant:tenant-1', mode: 'exclusive' },
    { key: 'saas-authz:project:tenant-1:project-1', mode: 'exclusive' },
    ...[...new Set(userIds)].sort().map((key) => ({ key, mode: 'exclusive' })),
    ...business.map((key) => ({ key, mode: 'exclusive' })),
  ];
  const actual = database.advisoryFences.slice(fenceStart, fenceStart + expected.length);
  assert.deepEqual(
    actual.map(({ key, mode }) => ({ key, mode })),
    expected,
  );
  const mutableIndex = statements.findIndex((sql) =>
    /FROM saas_api_keys[\s\S]*FOR UPDATE|INSERT INTO saas_api_keys/i.test(sql),
  );
  assert.ok(mutableIndex >= WRITE_ENTRY_SQL.length);
  assert.ok(
    actual.every(
      ({ statementIndex }) =>
        statementIndex >= statementStart + WRITE_ENTRY_SQL.length && statementIndex < statementStart + mutableIndex,
    ),
  );
}

function assertReaderOrder(database: FakeKeyDatabase, statementStart: number, fenceStart: number): void {
  const statements = database.statements.slice(statementStart);
  assert.equal(
    statements.some((sql) => WRITE_ENTRY_SQL.some((expected) => normalizedSql(expected) === normalizedSql(sql))),
    false,
  );
  assert.ok(database.advisoryFences.slice(fenceStart).every(({ mode }) => mode === 'shared'));
  assert.equal(
    statements.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/i.test(sql.trim())),
    false,
  );
}

test('create stores only a SHA-256 digest, returns a 256-bit secret once, and lists safe active metadata', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });

  const created = await service.create(baseContext, baseInput);
  assertWriterOrder(database, 0, 0, [baseContext.userId], [created.id], true);
  assert.match(created.secret, /^mr_live_[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(created.secret.slice('mr_live_'.length), 'base64url').byteLength, 32);
  assert.equal(created.supplyProfileId, 'profile-byok-1');
  assert.equal(created.supplyMode, 'byok');
  assert.equal(database.keys.length, 1);
  assert.equal(database.keys[0]?.key_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.equal(JSON.stringify(database.keys).includes(created.secret), false);
  assert.equal(JSON.stringify(database.keys).includes('secret'), false);

  const listStatementStart = database.statements.length;
  const listFenceStart = database.advisoryFences.length;
  const listed = await service.list(baseContext);
  assertReaderOrder(database, listStatementStart, listFenceStart);
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
  const authenticationStatementStart = database.statements.length;
  const authenticationFenceStart = database.advisoryFences.length;
  const authenticated = await service.authenticate(created.secret);
  assertReaderOrder(database, authenticationStatementStart, authenticationFenceStart);

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

  assertWriterOrder(database, 0, 0, [baseContext.userId], [created.id], true);
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
  assert.deepEqual(database.statements.slice(0, WRITE_ENTRY_SQL.length), [...WRITE_ENTRY_SQL]);

  // Exact scripted contract negatives, within the original whole case.
  await assert.rejects(database.query(WRITE_ENTRY_SQL[0]), /Invalid fresh write transaction entry/);
  await assert.rejects(database.query('SELECT pg_advisory_xact_lock(1396788563, 47)'), /Unimplemented fake SQL/);
  await assert.rejects(database.query("SET LOCAL lock_timeout = '3s'"), /Unimplemented fake SQL/);
  await assert.rejects(
    database.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))', ['user-1']),
    /Unimplemented fake SQL/,
  );
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.query('SELECT clock_timestamp() AS now');
      await tx.query(WRITE_ENTRY_SQL[0]);
    }),
    /Invalid fresh write transaction entry/,
  );
  await assert.rejects(
    database.transaction((tx) => tx.query(WRITE_ENTRY_SQL[1])),
    /Invalid fresh write transaction entry/,
  );
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.query(WRITE_ENTRY_SQL[0]);
      await tx.query(WRITE_ENTRY_SQL[3]);
    }),
    /Invalid fresh write transaction entry/,
  );
  await assert.rejects(
    database.transaction((tx) => tx.query('UPDATE saas_api_keys')),
    /Key mutation requires the complete fresh write entry/,
  );
  assert.equal(database.keys.length, 0);
  assert.equal(database.audits.length, 0);
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
  const rotationStatementStart = database.statements.length;
  const rotationFenceStart = database.advisoryFences.length;
  const replacement = await service.rotate(rotatingContext, original.id);
  assertWriterOrder(
    database,
    rotationStatementStart,
    rotationFenceStart,
    [rotatingContext.userId],
    [original.id, replacement.id],
    true,
  );
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
  const revokeStatementStart = database.statements.length;
  const revokeFenceStart = database.advisoryFences.length;
  const revoked = await service.revoke(baseContext, created.id);
  assertWriterOrder(database, revokeStatementStart, revokeFenceStart, [baseContext.userId], [created.id], false);
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

  const replayStatementStart = database.statements.length;
  const replayFenceStart = database.advisoryFences.length;
  const repeated = await service.revoke(baseContext, created.id);
  assertWriterOrder(database, replayStatementStart, replayFenceStart, [baseContext.userId], [created.id], false);
  assert.equal(
    database.statements.slice(replayStatementStart).some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/i.test(sql.trim())),
    false,
  );
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
  const rotateFenceStart = database.advisoryFences.length;
  const replacement = await service.rotate(rotatingContext, original.id);
  assertWriterOrder(
    database,
    rotateStatementStart,
    rotateFenceStart,
    [baseContext.userId, rotatingContext.userId],
    [original.id, replacement.id],
    true,
  );
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

  const aliases = new FakeKeyDatabase();
  const aliasService = new KeyService(aliases, { resolver: resolver(byokResolution) });
  const aliasCreated = await aliasService.createApiKey(baseContext, baseInput);
  assertWriterOrder(aliases, 0, 0, [baseContext.userId], [aliasCreated.id], true);
  const aliasRotateStart = aliases.statements.length;
  const aliasRotateFences = aliases.advisoryFences.length;
  const aliasReplacement = await aliasService.rotateApiKey(baseContext, aliasCreated.id);
  assertWriterOrder(
    aliases,
    aliasRotateStart,
    aliasRotateFences,
    [baseContext.userId],
    [aliasCreated.id, aliasReplacement.id],
    true,
  );
  const aliasRevokeStart = aliases.statements.length;
  const aliasRevokeFences = aliases.advisoryFences.length;
  const aliasRevoked = await aliasService.revokeApiKey(baseContext, aliasReplacement.id);
  assertWriterOrder(aliases, aliasRevokeStart, aliasRevokeFences, [baseContext.userId], [aliasReplacement.id], false);
  assert.equal(aliasRevoked.authzVersion, aliasReplacement.authzVersion + 1);
  assert.equal(aliases.audits.filter((audit) => audit.action === 'api_key.rotated').length, 1);
  assert.equal(aliases.audits.filter((audit) => audit.action === 'api_key.revoked').length, 1);
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

function customerFixture() {
  const database = new FakeKeyDatabase();
  database.setMembershipRoles(CUSTOMER_USER, 'owner', 'owner');
  const context = { ...baseContext, userId: CUSTOMER_USER };
  const identity = new SaasIdentityService(database);
  const service = new KeyService(database, { resolver: resolver(byokResolution) });
  return {
    database,
    context,
    identity,
    service,
    issue: () => identity.issueKeyMutationSession(CUSTOMER_TOKEN, CUSTOMER_CSRF),
  };
}

test('actual IdentityService native predicate issues opaque same-DB handle for three real KeyService mutations', async () => {
  const f = customerFixture(),
    handle = await f.issue();
  assert.deepEqual(Object.keys(handle), ['purpose']);
  assert.ok(Object.isFrozen(handle));
  const projection = JSON.stringify(handle);
  for (const privateValue of [
    CUSTOMER_TOKEN,
    CUSTOMER_CSRF,
    CUSTOMER_SESSION,
    CUSTOMER_USER,
    customerHash(CUSTOMER_TOKEN),
    customerHash(CUSTOMER_CSRF),
  ]) {
    assert.equal(projection.includes(privateValue), false);
  }
  let start = f.database.statements.length,
    fenceStart = f.database.advisoryFences.length;
  const created = await f.service.createAuthenticated(f.context, baseInput, handle);
  assertWriterOrder(f.database, start, fenceStart, [CUSTOMER_USER], [created.id], true);
  start = f.database.statements.length;
  fenceStart = f.database.advisoryFences.length;
  const rotated = await f.service.rotateAuthenticated(f.context, created.id, await f.issue());
  // issue is an independent preflight read, not a write-TX statement.
  const entry = f.database.statements.slice(start).findIndex((sql) => sql === WRITE_ENTRY_SQL[0]);
  assertWriterOrder(f.database, start + entry, fenceStart, [CUSTOMER_USER], [created.id, rotated.id], true);
  start = f.database.statements.length;
  fenceStart = f.database.advisoryFences.length;
  await f.service.revokeAuthenticated(f.context, rotated.id, handle);
  assertWriterOrder(f.database, start, fenceStart, [CUSTOMER_USER], [rotated.id], false);
  assert.equal(f.database.statements.filter((sql) => sql === CUSTOMER_KEY_MUTATION_CURRENT_SQL).length, 3);
  assert.equal(f.database.keys.length, 2);
  assert.ok(f.database.keys.every((key) => key.status === 'revoked'));
  assert.equal(/FOR\s+(?:UPDATE|SHARE)/i.test(CUSTOMER_KEY_MUTATION_CURRENT_SQL), false);
});

test('shape-only/copy, wrong actual DB and wrong operator cannot enter authenticated key write TX', async () => {
  const f = customerFixture(),
    handle = await f.issue();
  const before = f.database.statements.length;
  const fake: CustomerKeyMutationSessionHandle = { purpose: 'customer-key-mutation-session-v1' };
  for (const value of [fake, { ...handle }]) {
    await assert.rejects(f.service.createAuthenticated(f.context, baseInput, value), { status: 503 });
  }
  await assert.rejects(
    f.service.createAuthenticated({ ...f.context, userId: '33333333-3333-4333-8333-333333333333' }, baseInput, handle),
    { status: 401 },
  );
  const foreign = customerFixture();
  await assert.rejects(foreign.service.createAuthenticated(foreign.context, baseInput, handle), { status: 503 });
  assert.equal(f.database.statements.length, before);
  assert.equal(foreign.database.statements.length, 0);
  assert.equal(f.database.keys.length, 0);
});

test('same-DB handle cannot be revalidated on an unowned executor outside the actual G-first write callback', async () => {
  const f = customerFixture(),
    handle = await f.issue(),
    before = f.database.statements.length;
  await assert.rejects(revalidateCustomerKeyMutationSession(handle, f.database, f.database, CUSTOMER_USER), {
    status: 503,
  });
  assert.equal(f.database.statements.length, before);
});

for (const changed of ['revoked', 'expired', 'csrf', 'token', 'session', 'user', 'disabled'] as const) {
  test('actual issuer preflight is not live authority after fence wait changes ' + changed, async () => {
    const f = customerFixture(),
      handle = await f.issue();
    f.database.authorizationFenceHook = (_sql, values) => {
      if (values[0] !== 'saas-authz:tenant:tenant-1') return;
      const s = f.database.customerSession;
      if (changed === 'revoked') s.revoked_at = new Date('2026-09-28T00:00:00.000Z');
      if (changed === 'expired') s.expires_at = new Date('2026-09-28T00:00:00.000Z');
      if (changed === 'csrf') s.csrf_token_hash = customerHash('changed synthetic csrf');
      if (changed === 'token') s.token_hash = customerHash('changed synthetic token');
      if (changed === 'session') s.id = '44444444-4444-4444-8444-444444444444';
      if (changed === 'user') s.user_id = '33333333-3333-4333-8333-333333333333';
      if (changed === 'disabled') f.database.disabledUsers.add(CUSTOMER_USER);
    };
    await assert.rejects(
      f.service.createAuthenticated(f.context, baseInput, handle),
      changed === 'disabled' ? { code: 'KEY_ACCESS_DENIED' } : { status: 401 },
    );
    assert.equal(f.database.keys.length, 0);
    assert.equal(f.database.audits.length, 0);
    assert.equal(
      f.database.statements.some((sql) => /^INSERT INTO saas_api_keys/.test(sql.trim())),
      false,
    );
  });
}

test('session revoked between HTTP-style issuer and each authenticated mutation causes zero effects', async () => {
  for (const operation of ['create', 'rotate', 'revoke'] as const) {
    const f = customerFixture(),
      first = await f.issue();
    const created = await f.service.createAuthenticated(f.context, baseInput, first);
    const handle = await f.issue(),
      before = f.database.statements.length,
      audits = f.database.audits.length;
    f.database.authorizationFenceHook = (_sql, values) => {
      if (values[0] === 'saas-authz:project:tenant-1:project-1') f.database.customerSession.revoked_at = new Date();
    };
    const work =
      operation === 'create'
        ? f.service.createAuthenticated(f.context, baseInput, handle)
        : operation === 'rotate'
          ? f.service.rotateAuthenticated(f.context, created.id, handle)
          : f.service.revokeAuthenticated(f.context, created.id, handle);
    await assert.rejects(work, { status: 401 });
    assert.equal(f.database.keys.length, 1);
    assert.equal(f.database.keys[0]?.status, 'active');
    assert.equal(f.database.audits.length, audits);
    assert.equal(
      f.database.statements.slice(before).some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql.trim())),
      false,
    );
  }
});

test('real issuer rejects bad CSRF/current predicates and malformed native row rather than minting a DTO', async () => {
  const f = customerFixture();
  await assert.rejects(f.identity.issueKeyMutationSession(CUSTOMER_TOKEN, 'wrong synthetic csrf token'), {
    status: 401,
  });
  f.database.customerSession.revoked_at = new Date();
  await assert.rejects(f.issue(), { status: 401 });
  f.database.customerSession.revoked_at = null;
  f.database.customerSession.id = 'not-a-uuid';
  await assert.rejects(f.issue(), { status: 503 });
  assert.equal(f.database.keys.length, 0);
});

test('actual logout owns a G-first TX before original idempotent UPDATE and retains exact token/time rules', async () => {
  const calls: string[] = [],
    hashes: unknown[] = [];
  let active = false,
    transactions = 0,
    revokedAt: unknown = null,
    currentStart = 0;
  const timeout = "SELECT set_config('lock_timeout', '2s', TRUE), set_config('statement_timeout', '10s', TRUE)";
  const logoutSql = 'UPDATE saas_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1';
  const tx: SqlExecutor = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      assert.ok(active);
      const index = calls.length - currentStart;
      calls.push(sql);
      if (sql === timeout && index === 0 && values.length === 0) return { rows: [], rowCount: 1 };
      if (sql === WRITE_ENTRY_SQL[3] && index === 1 && values.length === 0) return { rows: [], rowCount: 1 };
      if (normalizedSql(sql) === normalizedSql(logoutSql) && index === 2) {
        assert.equal(values.length, 2);
        assert.equal(values[0], customerHash(CUSTOMER_TOKEN));
        assert.equal(values[1], '2026-09-28T00:00:00.000Z');
        hashes.push(values[0]);
        revokedAt ??= values[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected logout fixture SQL/order');
    },
  };
  const database: SaasDatabase = {
    async query<Row>(_sql: string): Promise<SqlResult<Row>> {
      throw new Error('Logout bypassed own TX');
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      assert.equal(active, false);
      currentStart = calls.length;
      active = true;
      transactions++;
      try {
        return await work(tx);
      } finally {
        active = false;
      }
    },
    async migrate() {
      throw new Error('No fixture migration');
    },
    async verifySchema() {
      throw new Error('No fixture readiness');
    },
    async ping() {
      throw new Error('No fixture ping');
    },
    async close() {},
  };
  const identity = new SaasIdentityService(database, { now: () => new Date('2026-09-28T00:00:00.000Z') });
  await identity.logout(CUSTOMER_TOKEN);
  await identity.logout(CUSTOMER_TOKEN);
  await identity.logout('short');
  assert.equal(transactions, 2);
  assert.equal(calls.length, 6);
  assert.equal(hashes.length, 2);
  assert.equal(revokedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(
    calls.some((sql) => /FOR\s+(?:UPDATE|SHARE)/i.test(sql)),
    false,
  );
});

test('create seeds a disabled v1 IP policy head and get returns it', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  assert.equal(database.ipPolicies.length, 1);
  assert.deepEqual(database.ipPolicies[0], {
    tenant_id: baseContext.tenantId,
    project_id: baseContext.projectId,
    key_id: created.id,
    version: '1',
    mode: 'disabled',
    rules: [],
    created_at: new Date('2026-09-28T00:00:00.000Z'),
    updated_at: new Date('2026-09-28T00:00:00.000Z'),
  });

  const snapshot = await service.getKeyIpPolicy(baseContext, created.id);
  assert.deepEqual(snapshot, {
    tenantId: baseContext.tenantId,
    projectId: baseContext.projectId,
    keyId: created.id,
    version: '1',
    authzVersion: 1,
    policy: { mode: 'disabled', rules: [] },
  });
});

test('IP policy replacement advances the head CAS, invalidates key authorization and audits', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  const replaced = await service.replaceKeyIpPolicy(baseContext, created.id, {
    expectedVersion: '1',
    policy: { mode: 'allowlist', rules: ['203.0.113.10', '203.0.113.0/24'] },
  });
  assert.equal(replaced.version, '2');
  assert.equal(replaced.authzVersion, 2);
  assert.deepEqual(replaced.policy, { mode: 'allowlist', rules: ['203.0.113.0/24', '203.0.113.10/32'] });
  assert.equal(database.keys[0]?.authz_version, 2);
  assert.equal(database.ipPolicies[0]?.version, '2');
  assert.deepEqual(database.ipPolicies[0]?.rules, ['203.0.113.0/24', '203.0.113.10/32']);
  assert.equal(
    database.audits.some((audit) => audit.action === 'api_key.ip_policy_replaced' && audit.targetId === created.id),
    true,
  );

  const snapshot = await service.getKeyIpPolicy(baseContext, created.id);
  assert.equal(snapshot.version, '2');
  assert.equal(snapshot.authzVersion, 2);
  assert.deepEqual(snapshot.policy.rules, ['203.0.113.0/24', '203.0.113.10/32']);
});

test('IP policy replacement rejects a stale expectedVersion and leaves all state unchanged', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  await assert.rejects(
    () =>
      service.replaceKeyIpPolicy(baseContext, created.id, {
        expectedVersion: '2',
        policy: { mode: 'denyall', rules: [] },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'KEY_IP_POLICY_VERSION_CONFLICT');
      assert.equal((error as { status?: number }).status, 409);
      return true;
    },
  );
  assert.equal(database.ipPolicies[0]?.version, '1');
  assert.equal(database.ipPolicies[0]?.mode, 'disabled');
  assert.equal(database.keys[0]?.authz_version, 1);
  assert.equal(
    database.audits.some((audit) => audit.action === 'api_key.ip_policy_replaced'),
    false,
  );
});

test('IP policy replacement rejects invalid DTOs, unknown keys and revoked keys', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  for (const input of [
    { expectedVersion: '0', policy: { mode: 'disabled', rules: [] } },
    { expectedVersion: '1', policy: { mode: 'allowlist', rules: [] } },
    { expectedVersion: '1', policy: { mode: 'denyall', rules: ['203.0.113.0/24'] } },
    { expectedVersion: '1', policy: { mode: 'allowlist', rules: ['not-an-address'] } },
  ]) {
    await assert.rejects(
      () => service.replaceKeyIpPolicy(baseContext, created.id, input as never),
      (error: unknown) => (error as { code?: string }).code === 'KEY_INVALID_INPUT',
    );
  }
  await assert.rejects(
    () =>
      service.replaceKeyIpPolicy(baseContext, 'missing-key', {
        expectedVersion: '1',
        policy: { mode: 'disabled', rules: [] },
      }),
    (error: unknown) => (error as { code?: string }).code === 'KEY_NOT_FOUND',
  );
  await assert.rejects(
    () => service.getKeyIpPolicy(baseContext, 'missing-key'),
    (error: unknown) => (error as { code?: string }).code === 'KEY_NOT_FOUND',
  );

  await service.revoke(baseContext, created.id);
  await assert.rejects(
    () =>
      service.replaceKeyIpPolicy(baseContext, created.id, {
        expectedVersion: '1',
        policy: { mode: 'denyall', rules: [] },
      }),
    (error: unknown) => (error as { code?: string }).code === 'KEY_ALREADY_REVOKED',
  );
  assert.equal(database.ipPolicies[0]?.mode, 'disabled');
});

test('rotation carries the effective IP policy into a fresh v1 head on the replacement key', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  await service.replaceKeyIpPolicy(baseContext, created.id, {
    expectedVersion: '1',
    policy: { mode: 'allowlist', rules: ['2001:db8::/32'] },
  });
  const rotated = await service.rotate(baseContext, created.id);
  assert.notEqual(rotated.id, created.id);
  assert.equal(database.ipPolicies.length, 2);
  const inherited = database.ipPolicies.find((policy) => policy.key_id === rotated.id);
  assert.ok(inherited);
  assert.equal(inherited.version, '1');
  assert.equal(inherited.mode, 'allowlist');
  assert.deepEqual(inherited.rules, ['2001:db8::/32']);
  const snapshot = await service.getKeyIpPolicy(baseContext, rotated.id);
  assert.equal(snapshot.version, '1');
  assert.deepEqual(snapshot.policy, { mode: 'allowlist', rules: ['2001:db8::/32'] });
});

const verifiedZeroCounter = { status: 'verified', settled: '0', outstandingReserved: '0' } as const;

test('create seeds an unlimited self-lineage v1 budget head and get returns verified counters', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  assert.equal(database.budgetPolicies.length, 1);
  assert.deepEqual(database.budgetPolicies[0], {
    tenant_id: baseContext.tenantId,
    project_id: baseContext.projectId,
    key_id: created.id,
    lineage_id: created.id,
    version: '1',
    token_daily: null,
    token_lifetime: null,
    charge_daily: null,
    charge_lifetime: null,
  });

  database.budgetCounters.push(
    {
      tenant_id: baseContext.tenantId,
      project_id: baseContext.projectId,
      lineage_id: created.id,
      window_kind: 'daily',
      day: '2026-09-28',
      token_settled: '40',
      token_outstanding_reserved: '10',
      charge_settled: '0',
      charge_outstanding_reserved: '0',
      charge_currency: null,
    },
    {
      tenant_id: baseContext.tenantId,
      project_id: baseContext.projectId,
      lineage_id: created.id,
      window_kind: 'daily',
      day: '2026-09-27',
      token_settled: '999',
      token_outstanding_reserved: '0',
      charge_settled: '0',
      charge_outstanding_reserved: '0',
      charge_currency: null,
    },
    {
      tenant_id: baseContext.tenantId,
      project_id: baseContext.projectId,
      lineage_id: created.id,
      window_kind: 'lifetime',
      day: '0001-01-01',
      token_settled: '400',
      token_outstanding_reserved: '10',
      charge_settled: '0',
      charge_outstanding_reserved: '0',
      charge_currency: null,
    },
  );

  const snapshot = await service.getKeyBudgetPolicy(baseContext, created.id);
  assert.deepEqual(snapshot, {
    tenantId: baseContext.tenantId,
    projectId: baseContext.projectId,
    keyId: created.id,
    lineageId: created.id,
    version: '1',
    authzVersion: 1,
    supplyMode: 'byok',
    tokenUnit: 'tokens',
    tokenCountingSemanticsVersion: 'token-units-v1',
    currentWindow: {
      timezone: 'UTC',
      startInclusive: '2026-09-28T00:00:00.000Z',
      endExclusive: '2026-09-29T00:00:00.000Z',
    },
    tokenCaps: { daily: null, lifetime: null },
    // The stale 2026-09-27 daily row never leaks into the current window.
    tokenUsage: {
      daily: { status: 'verified', settled: '40', outstandingReserved: '10' },
      lifetime: { status: 'verified', settled: '400', outstandingReserved: '10' },
    },
    customerChargeBudget: null,
  });
});

test('budget policy replacement advances the head CAS, invalidates key authorization and audits', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  const replaced = await service.replaceKeyBudgetPolicy(baseContext, created.id, {
    expectedVersion: '1',
    tokenCaps: { daily: '1000', lifetime: '100000' },
    customerChargeCaps: null,
  });
  assert.equal(replaced.version, '2');
  assert.equal(replaced.authzVersion, 2);
  assert.equal(replaced.supplyMode, 'byok');
  assert.deepEqual(replaced.tokenCaps, { daily: '1000', lifetime: '100000' });
  assert.equal(replaced.customerChargeBudget, null);
  assert.deepEqual(replaced.tokenUsage, { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter });
  assert.equal(database.keys[0]?.authz_version, 2);
  assert.equal(database.budgetPolicies[0]?.version, '2');
  assert.equal(database.budgetPolicies[0]?.token_daily, '1000');
  assert.equal(
    database.audits.some((audit) => audit.action === 'api_key.budget_policy_replaced' && audit.targetId === created.id),
    true,
  );

  const snapshot = await service.getKeyBudgetPolicy(baseContext, created.id);
  assert.equal(snapshot.version, '2');
  assert.equal(snapshot.authzVersion, 2);
  assert.deepEqual(snapshot.tokenCaps, { daily: '1000', lifetime: '100000' });
});

test('budget policy replacement rejects a stale expectedVersion and leaves all state unchanged', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  await assert.rejects(
    () =>
      service.replaceKeyBudgetPolicy(baseContext, created.id, {
        expectedVersion: '2',
        tokenCaps: { daily: '0', lifetime: null },
        customerChargeCaps: null,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'KEY_BUDGET_POLICY_VERSION_CONFLICT');
      assert.equal((error as { status?: number }).status, 409);
      return true;
    },
  );
  assert.equal(database.budgetPolicies[0]?.version, '1');
  assert.equal(database.budgetPolicies[0]?.token_daily, null);
  assert.equal(database.keys[0]?.authz_version, 1);
  assert.equal(
    database.audits.some((audit) => audit.action === 'api_key.budget_policy_replaced'),
    false,
  );
});

test('budget policy replacement rejects invalid DTOs, unknown keys and revoked keys', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  for (const input of [
    { expectedVersion: '0', tokenCaps: { daily: null, lifetime: null }, customerChargeCaps: null },
    { expectedVersion: '1', tokenCaps: { daily: '1.5', lifetime: null }, customerChargeCaps: null },
    { expectedVersion: '1', tokenCaps: { daily: null }, customerChargeCaps: null },
    { expectedVersion: '1', tokenCaps: { daily: null, lifetime: null } },
    {
      expectedVersion: '1',
      tokenCaps: { daily: null, lifetime: null },
      customerChargeCaps: { daily: '1', lifetime: null },
    },
  ]) {
    await assert.rejects(
      () => service.replaceKeyBudgetPolicy(baseContext, created.id, input as never),
      (error: unknown) => (error as { code?: string }).code === 'KEY_INVALID_INPUT',
    );
  }
  await assert.rejects(
    () =>
      service.replaceKeyBudgetPolicy(baseContext, 'missing-key', {
        expectedVersion: '1',
        tokenCaps: { daily: null, lifetime: null },
        customerChargeCaps: null,
      }),
    (error: unknown) => (error as { code?: string }).code === 'KEY_NOT_FOUND',
  );
  await assert.rejects(
    () => service.getKeyBudgetPolicy(baseContext, 'missing-key'),
    (error: unknown) => (error as { code?: string }).code === 'KEY_NOT_FOUND',
  );

  await service.revoke(baseContext, created.id);
  await assert.rejects(
    () =>
      service.replaceKeyBudgetPolicy(baseContext, created.id, {
        expectedVersion: '1',
        tokenCaps: { daily: '100', lifetime: null },
        customerChargeCaps: null,
      }),
    (error: unknown) => (error as { code?: string }).code === 'KEY_ALREADY_REVOKED',
  );
  assert.equal(database.budgetPolicies[0]?.token_daily, null);
});

const platformResolution: SupplyProfileResolution = {
  entitlementId: 'entitlement-platform-1',
  profileId: 'profile-platform-1',
  mode: 'platform',
  allowedModels: ['model-a'],
  entitlementAuthzVersion: 7,
  supplyProfileAuthzVersion: 8,
  modelScopeVersion: 8,
};

test('platform charge budgets bind the single wallet currency and fail closed without one', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(platformResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, { ...baseInput, supplyMode: 'platform' });
  const replaced = await service.replaceKeyBudgetPolicy(baseContext, created.id, {
    expectedVersion: '1',
    tokenCaps: { daily: '1000', lifetime: null },
    customerChargeCaps: { daily: '5000', lifetime: '90000' },
  });
  assert.equal(replaced.supplyMode, 'platform');
  assert.deepEqual(replaced.customerChargeBudget, {
    currency: 'USD',
    unit: 'minor_units',
    caps: { daily: '5000', lifetime: '90000' },
    usage: { daily: verifiedZeroCounter, lifetime: verifiedZeroCounter },
  });

  // Without a counter-stamped or uniquely resolvable wallet currency the read
  // fails closed instead of fabricating a charge budget currency.
  database.walletCurrency = null;
  await assert.rejects(
    () => service.getKeyBudgetPolicy(baseContext, created.id),
    (error: unknown) => (error as { code?: string }).code === 'KEY_STORAGE_ERROR',
  );

  // A lineage counter-stamped currency wins even when the wallet is unavailable.
  database.budgetCounters.push({
    tenant_id: baseContext.tenantId,
    project_id: baseContext.projectId,
    lineage_id: created.id,
    window_kind: 'lifetime',
    day: '0001-01-01',
    token_settled: '0',
    token_outstanding_reserved: '0',
    charge_settled: '10',
    charge_outstanding_reserved: '5',
    charge_currency: 'EUR',
  });
  const restamped = await service.getKeyBudgetPolicy(baseContext, created.id);
  assert.equal(restamped.supplyMode, 'platform');
  assert.equal(restamped.customerChargeBudget?.currency, 'EUR');
  assert.deepEqual(restamped.customerChargeBudget?.usage, {
    daily: verifiedZeroCounter,
    lifetime: { status: 'verified', settled: '10', outstandingReserved: '5' },
  });
});

test('rotation inherits the budget lineage and caps into a fresh v1 head', async () => {
  const database = new FakeKeyDatabase();
  const service = new KeyService(database, {
    resolver: resolver(byokResolution),
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const created = await service.create(baseContext, baseInput);
  await service.replaceKeyBudgetPolicy(baseContext, created.id, {
    expectedVersion: '1',
    tokenCaps: { daily: '100', lifetime: '5000' },
    customerChargeCaps: null,
  });
  const rotated = await service.rotate(baseContext, created.id);
  assert.notEqual(rotated.id, created.id);
  assert.equal(database.budgetPolicies.length, 2);
  const inherited = database.budgetPolicies.find((policy) => policy.key_id === rotated.id);
  assert.ok(inherited);
  assert.equal(inherited.version, '1');
  assert.equal(inherited.lineage_id, created.id);
  assert.equal(inherited.token_daily, '100');
  assert.equal(inherited.token_lifetime, '5000');

  const snapshot = await service.getKeyBudgetPolicy(baseContext, rotated.id);
  assert.equal(snapshot.version, '1');
  assert.equal(snapshot.lineageId, created.id);
  assert.deepEqual(snapshot.tokenCaps, { daily: '100', lifetime: '5000' });
});
