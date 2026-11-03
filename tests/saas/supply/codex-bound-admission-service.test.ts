import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../src/saas/platform/governance/errors.js';
import { codexTrustedProfileDigest } from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';
import {
  CodexBoundAdmissionService,
  type CodexBoundProfileState,
} from '../../../src/saas/supply/codex-bound-admission-service.js';

/*
 * 方案1 (M1-B) — the Codex trusted-bound admission workflow. Critical
 * capabilities under test: the server-side digest recomputation over the
 * canonical profile shape, the pending-first lifecycle (approval is the only
 * path to admitted), fail-closed validation, and the governance audit trail.
 */

const ACTOR_ID = '10000000-0000-4000-8000-0000000000aa';
const actor: PlatformAdminActor = {
  userId: ACTOR_ID,
  sessionId: '10000000-0000-4000-8000-0000000000c1',
  roles: ['operations'],
};

interface StoredRow {
  digest: string;
  endpoint: string;
  product_id: string;
  model: string;
  operation: string;
  transport: string;
  continuation_mode: string;
  bounds: string;
  backend_revision: string;
  evidence_version: string;
  evidence_reference: string;
  valid_from_ms: string;
  expires_at_ms: string;
  state: CodexBoundProfileState;
  submitted_by_user_id: string;
  approved_by_user_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

class AdmissionFake implements SqlExecutor {
  rows = new Map<string, StoredRow>();
  readonly audits: string[] = [];
  assignedRoles: readonly string[] = ['operations'];

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM saas_platform_sessions AS s')) {
      rows = [{ id: actor.sessionId, user_id: ACTOR_ID }];
    } else if (sql.includes('FROM saas_platform_role_assignments')) {
      rows = this.assignedRoles.map((role) => ({ role }));
    } else if (sql.startsWith('INSERT INTO saas_codex_trusted_bound_profiles')) {
      const digest = String(values[0]);
      if (!this.rows.has(digest)) {
        this.rows.set(digest, {
          digest,
          endpoint: String(values[1]),
          product_id: String(values[2]),
          model: String(values[3]),
          operation: String(values[4]),
          transport: String(values[5]),
          continuation_mode: String(values[6]),
          bounds: String(values[7]),
          backend_revision: String(values[8]),
          evidence_version: String(values[9]),
          evidence_reference: String(values[10]),
          valid_from_ms: String(values[11]),
          expires_at_ms: String(values[12]),
          state: 'pending',
          submitted_by_user_id: String(values[13]),
          approved_by_user_id: null,
          approved_at: null,
          created_at: '2026-11-04T00:00:00.000Z',
          updated_at: '2026-11-04T00:00:00.000Z',
        });
        rows = [{ digest, state: 'pending' }];
      }
    } else if (sql.startsWith('UPDATE saas_codex_trusted_bound_profiles')) {
      const digest = String(values[0]);
      const row = this.rows.get(digest);
      if (row && row.state === values[3]) {
        row.state = values[2] as CodexBoundProfileState;
        if (row.state === 'approved') {
          row.approved_by_user_id = String(values[1]);
          row.approved_at = '2026-11-04T01:00:00.000Z';
        }
        row.updated_at = '2026-11-04T01:00:00.000Z';
        rows = [
          {
            digest,
            state: row.state,
            approved_by_user_id: row.approved_by_user_id,
            approved_at: row.approved_at,
            updated_at: row.updated_at,
          },
        ];
      }
    } else if (sql.includes('SELECT state FROM saas_codex_trusted_bound_profiles')) {
      const row = this.rows.get(String(values[0]));
      rows = row ? [{ state: row.state }] : [];
    } else if (sql.includes('FROM saas_codex_trusted_bound_profiles') && sql.includes('count(*)')) {
      const state = values.length === 1 ? String(values[0]) : undefined;
      const items = [...this.rows.values()].filter((row) => state === undefined || row.state === state);
      rows = [{ total: String(items.length) }];
    } else if (sql.includes('FROM saas_codex_trusted_bound_profiles') && sql.startsWith('SELECT')) {
      const state = values.length === 1 ? String(values[0]) : undefined;
      const items = [...this.rows.values()]
        .filter((row) => state === undefined || row.state === state)
        .map((row) => ({ ...row, bounds: JSON.parse(row.bounds) }));
      rows = items;
    } else if (sql.includes('INSERT INTO saas_audit_events')) {
      this.audits.push(String(values[3]));
      rows = [{}];
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

// The canonical in-memory shape the digest is defined over: epoch milliseconds
// as numbers, envelope integers as decimal strings, optional fields as null.
const WIRE_PROFILE = {
  scope: {
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    productId: 'codex-chatgpt',
    model: 'gpt-5.2-codex',
    operation: 'responses',
    transport: 'http',
    continuationMode: 'canonical-replay',
  },
  backendRevision: 'backend-rev-1',
  evidenceVersion: 'proof-v1',
  evidenceReference: 'ops-live-evidence-checklist-entry',
  validFromMs: 1000,
  expiresAtMs: '2000',
  bounds: {
    inputTotalUpperBound: 100,
    inputUncachedUpperBound: '100',
    cacheReadUpperBound: 100n,
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '20',
    reasoningOutputUpperBound: 20,
    feasibleInputBuckets: ['input'],
  },
};

const CANONICAL_BOUNDS = {
  inputTotalUpperBound: '100',
  inputUncachedUpperBound: '100',
  cacheReadUpperBound: '100',
  cacheWriteUpperBound: '0',
  cacheWrite5mUpperBound: '0',
  cacheWrite1hUpperBound: '0',
  outputTotalUpperBound: '20',
  reasoningOutputUpperBound: '20',
  feasibleInputBuckets: ['input'],
  perUnitUnitsUpperBound: null,
  sizeTier: null,
};

test('submit normalizes wire forms and recomputes the digest server-side', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const result = await service.submit(actor, WIRE_PROFILE);
  assert.equal(result.status, 'created');
  assert.equal(result.state, 'pending');
  const expectedDigest = codexTrustedProfileDigest({
    scope: WIRE_PROFILE.scope,
    backendRevision: WIRE_PROFILE.backendRevision,
    evidenceVersion: WIRE_PROFILE.evidenceVersion,
    evidenceReference: WIRE_PROFILE.evidenceReference,
    validFromMs: 1000,
    expiresAtMs: 2000,
    bounds: CANONICAL_BOUNDS,
  });
  assert.equal(result.digest, expectedDigest);
  const stored = fake.rows.get(expectedDigest);
  assert.ok(stored);
  // The stored jsonb is the canonical form, so a round-trip reproduces the digest.
  assert.equal(stored.bounds, JSON.stringify(CANONICAL_BOUNDS));
  assert.equal(stored.valid_from_ms, '1000');
  assert.equal(stored.expires_at_ms, '2000');
  assert.equal(stored.state, 'pending');
  assert.equal(stored.submitted_by_user_id, ACTOR_ID);
  assert.deepEqual(fake.audits, ['codex_bound_profile.submitted']);
});

test('duplicate submissions return the existing state without a second audit', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const first = await service.submit(actor, WIRE_PROFILE);
  const second = await service.submit(actor, WIRE_PROFILE);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.digest, first.digest);
  assert.equal(second.state, 'pending');
  assert.equal(fake.rows.size, 1);
  assert.deepEqual(fake.audits, ['codex_bound_profile.submitted']);
});

test('invalid submissions fail closed without any insert', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const invalid = [
    { ...WIRE_PROFILE, extra: 1 },
    { ...WIRE_PROFILE, scope: { ...WIRE_PROFILE.scope, transport: 'grpc' } },
    { ...WIRE_PROFILE, scope: { ...WIRE_PROFILE.scope, continuationMode: 'lazy' } },
    { ...WIRE_PROFILE, validFromMs: 2000, expiresAtMs: 1000 },
    { ...WIRE_PROFILE, bounds: { ...WIRE_PROFILE.bounds, cacheReadUpperBound: undefined } },
    { ...WIRE_PROFILE, bounds: { ...WIRE_PROFILE.bounds, feasibleInputBuckets: 'input' } },
    { ...WIRE_PROFILE, bounds: { ...WIRE_PROFILE.bounds, extra: 1 } },
    null,
  ];
  for (const input of invalid) {
    await assert.rejects(
      () => service.submit(actor, input),
      (error: unknown) => {
        assert.ok(error instanceof PlatformGovernanceError);
        assert.equal(error.code, 'GOVERNANCE_INVALID_INPUT');
        return true;
      },
    );
  }
  assert.equal(fake.rows.size, 0);
  assert.deepEqual(fake.audits, []);
});

test('approval is the only path from pending to the admitted state', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const { digest } = await service.submit(actor, WIRE_PROFILE);

  const approved = await service.approve(actor, { digest });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedByUserId, ACTOR_ID);
  assert.ok(approved.approvedAt);
  assert.equal(fake.rows.get(digest)?.state, 'approved');

  // Re-approval and rejection after approval both fail closed.
  await assert.rejects(() => service.approve(actor, { digest }), PlatformGovernanceError);
  await assert.rejects(() => service.reject(actor, { digest }), PlatformGovernanceError);
  assert.equal(fake.rows.get(digest)?.state, 'approved');
  assert.deepEqual(fake.audits, ['codex_bound_profile.submitted', 'codex_bound_profile.approved']);
});

test('reject lands rejected without lineage; retire only withdraws approved profiles', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const { digest } = await service.submit(actor, WIRE_PROFILE);

  await assert.rejects(() => service.retire(actor, { digest }), PlatformGovernanceError);
  const rejected = await service.reject(actor, { digest });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.approvedByUserId, null);
  assert.equal(fake.rows.get(digest)?.state, 'rejected');
  // Rejected is terminal for this workflow: no further transitions apply.
  await assert.rejects(() => service.approve(actor, { digest }), PlatformGovernanceError);
  await assert.rejects(() => service.reject(actor, { digest }), PlatformGovernanceError);

  const { digest: second } = await service.submit(actor, { ...WIRE_PROFILE, backendRevision: 'backend-rev-2' });
  await service.approve(actor, { digest: second });
  const retired = await service.retire(actor, { digest: second });
  assert.equal(retired.state, 'retired');
  assert.equal(fake.rows.get(second)?.state, 'retired');
  await assert.rejects(() => service.retire(actor, { digest: second }), PlatformGovernanceError);
});

test('unknown digests are not found and malformed digests are invalid', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  await assert.rejects(
    () => service.approve(actor, { digest: '0'.repeat(64) }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.code === 'GOVERNANCE_NOT_FOUND',
  );
  await assert.rejects(
    () => service.approve(actor, { digest: 'not-hex' }),
    (error: unknown) => error instanceof PlatformGovernanceError && error.code === 'GOVERNANCE_INVALID_INPUT',
  );
});

test('actors without an operations-capable role are forbidden', async () => {
  const fake = new AdmissionFake();
  fake.assignedRoles = ['support-readonly'];
  const service = new CodexBoundAdmissionService(fake);
  await assert.rejects(
    () => service.submit(actor, WIRE_PROFILE),
    (error: unknown) => error instanceof PlatformGovernanceError && error.code === 'GOVERNANCE_FORBIDDEN',
  );
  assert.equal(fake.rows.size, 0);
});

test('list returns the ledger with the state filter and lineage columns', async () => {
  const fake = new AdmissionFake();
  const service = new CodexBoundAdmissionService(fake);
  const first = await service.submit(actor, WIRE_PROFILE);
  const second = await service.submit(actor, { ...WIRE_PROFILE, backendRevision: 'backend-rev-2' });
  await service.approve(actor, { digest: second.digest });

  const all = await service.list(actor, {});
  assert.equal(all.total, '2');
  assert.equal(all.items.length, 2);
  assert.deepEqual(all.items.map((item) => item.state).sort(), ['approved', 'pending']);
  const pending = await service.list(actor, { state: 'pending' });
  assert.equal(pending.total, '1');
  assert.equal(pending.items[0]?.digest, first.digest);
  const approvedItem = all.items.find((item) => item.state === 'approved');
  assert.ok(approvedItem);
  assert.equal(approvedItem.approvedByUserId, ACTOR_ID);
  assert.ok(approvedItem.approvedAt);
  // The stored jsonb round-trips into the exact canonical bounds.
  assert.deepEqual(approvedItem.bounds, CANONICAL_BOUNDS);
  await assert.rejects(() => service.list(actor, { state: 'bogus' }), PlatformGovernanceError);
});
