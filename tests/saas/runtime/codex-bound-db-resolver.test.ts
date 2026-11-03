import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { createDbCodexTrustedBoundProfileResolver } from '../../../src/saas/runtime/codex-bound-db-resolver.js';
import {
  codexBoundCompilerVersion,
  codexTrustedProfileDigest,
} from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';

/*
 * 方案1 (M1-C) — the gateway-side Codex trusted-bound DB resolver. Critical
 * capabilities: only ops-approved, digest-verified, margin-satisfying profiles
 * are admitted; the TTL cache reads the ledger once per interval (never per
 * call); and read failures fail closed without breaking the resolver.
 */

const SCOPE = {
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  productId: 'codex-chatgpt',
  model: 'gpt-5.2-codex',
  operation: 'responses',
  transport: 'http',
  continuationMode: 'canonical-replay',
} as const;

const BOUNDS = {
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

function profile(validFromMs: number, expiresAtMs: number) {
  return {
    scope: SCOPE,
    backendRevision: 'backend-rev-1',
    evidenceVersion: 'proof-v1',
    evidenceReference: 'ops-live-evidence-checklist-entry',
    validFromMs,
    expiresAtMs,
    bounds: BOUNDS,
  };
}

function row(validFromMs: number, expiresAtMs: number, digest: string) {
  return {
    digest,
    endpoint: SCOPE.endpoint,
    product_id: SCOPE.productId,
    model: SCOPE.model,
    operation: SCOPE.operation,
    transport: SCOPE.transport,
    continuation_mode: SCOPE.continuationMode,
    bounds: BOUNDS,
    backend_revision: 'backend-rev-1',
    evidence_version: 'proof-v1',
    evidence_reference: 'ops-live-evidence-checklist-entry',
    valid_from_ms: String(validFromMs),
    expires_at_ms: String(expiresAtMs),
  };
}

class LedgerFake implements SqlExecutor {
  rows: Record<string, unknown>[] = [];
  fail = false;
  reads = 0;

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    if (sql.includes('FROM saas_codex_trusted_bound_profiles')) {
      this.reads += 1;
      if (this.fail) throw new Error('ledger unavailable');
      return { rows: this.rows as Row[], rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

test('approved ledger rows round-trip: resolve returns the admission digest', async () => {
  const fake = new LedgerFake();
  const p = profile(1000, 60_000);
  const digest = codexTrustedProfileDigest(p);
  fake.rows = [row(1000, 60_000, digest)];
  const resolver = await createDbCodexTrustedBoundProfileResolver({
    database: fake,
    expiryMarginMs: 5000,
    now: () => 2000,
  });
  const resolved = resolver.resolve(SCOPE);
  assert.ok(resolved);
  assert.equal(resolved.digest, digest);
  assert.deepEqual(resolved.profile.bounds, BOUNDS);
  assert.equal(fake.reads, 1);
});

test('the expiry margin guards admission but not digest activity', async () => {
  const fake = new LedgerFake();
  const p = profile(1000, 10_000);
  const digest = codexTrustedProfileDigest(p);
  fake.rows = [row(1000, 10_000, digest)];
  const resolver = await createDbCodexTrustedBoundProfileResolver({
    database: fake,
    expiryMarginMs: 5000,
    now: () => 6000,
  });
  // 4000ms remain but the 5000ms margin requires more: admission fails closed.
  assert.equal(resolver.resolve(SCOPE), null);
  assert.equal(resolver.sendProfile(codexBoundCompilerVersion('compiler', p), 'compiler', SCOPE), null);
  // isDigestActive answers settlement questions and applies no margin.
  assert.equal(resolver.isDigestActive(digest), true);
  const readiness = resolver.readiness();
  assert.equal(readiness.admittedProfileCount, 1);
});

test('scope mismatches, not-yet-valid and corrupt-digest rows never admit', async () => {
  const fake = new LedgerFake();
  const p = profile(1000, 60_000);
  const digest = codexTrustedProfileDigest(p);
  fake.rows = [
    // Corrupt: the recorded digest does not match the recomputed one.
    row(1000, 60_000, '0'.repeat(64)),
    // Not yet valid.
    row(5000, 60_000, codexTrustedProfileDigest(profile(5000, 60_000))),
    // The healthy row.
    row(1000, 60_000, digest),
  ];
  const resolver = await createDbCodexTrustedBoundProfileResolver({
    database: fake,
    expiryMarginMs: 5000,
    now: () => 2000,
  });
  assert.ok(resolver.resolve(SCOPE));
  assert.equal(resolver.resolve(SCOPE)?.digest, digest);
  assert.equal(resolver.resolve({ ...SCOPE, model: 'other-model' }), null);
  assert.equal(resolver.resolve({ ...SCOPE, continuationMode: 'full' }), null);
});

test('the TTL cache reads once per interval and refresh picks up new approvals', async () => {
  const fake = new LedgerFake();
  const first = profile(1000, 100_000);
  fake.rows = [row(1000, 100_000, codexTrustedProfileDigest(first))];
  let clock = 2000;
  const resolver = await createDbCodexTrustedBoundProfileResolver({
    database: fake,
    refreshIntervalMs: 30_000,
    expiryMarginMs: 5000,
    now: () => clock,
  });
  resolver.resolve(SCOPE);
  resolver.resolve(SCOPE);
  resolver.isDigestActive(codexTrustedProfileDigest(first));
  assert.equal(fake.reads, 1);

  // A second profile with a distinct scope is approved while the snapshot is
  // still fresh: it must not be visible yet.
  const second = { ...profile(3000, 100_000), scope: { ...SCOPE, model: 'gpt-5.2-codex-mini' } };
  const secondDigest = codexTrustedProfileDigest(second);
  fake.rows.push({ ...row(3000, 100_000, secondDigest), model: 'gpt-5.2-codex-mini' });
  assert.equal(resolver.resolve({ ...SCOPE, model: 'gpt-5.2-codex-mini' }), null);
  clock += 30_000; // TTL expires; the next call triggers one coalesced refresh.
  resolver.resolve(SCOPE);
  await resolver.refresh(); // joins the in-flight background refresh.
  assert.equal(fake.reads, 2);
  assert.ok(resolver.resolve({ ...SCOPE, model: 'gpt-5.2-codex-mini' }));
  assert.equal(resolver.readiness().admittedProfileCount, 2);
});

test('ledger read failures fail closed and never reject', async () => {
  const fake = new LedgerFake();
  fake.fail = true;
  const resolver = await createDbCodexTrustedBoundProfileResolver({
    database: fake,
    expiryMarginMs: 5000,
    now: () => 2000,
  });
  assert.equal(resolver.resolve(SCOPE), null);
  assert.equal(resolver.readiness().admittedProfileCount, 0);
  assert.match(resolver.readiness().reason, /ledger read failed|unavailable/);

  // Recovery via explicit refresh.
  fake.fail = false;
  fake.rows = [row(1000, 60_000, codexTrustedProfileDigest(profile(1000, 60_000)))];
  await resolver.refresh();
  assert.ok(resolver.resolve(SCOPE));
});
