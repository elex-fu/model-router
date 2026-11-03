import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { createBuiltinUsageUpperBoundEstimator } from '../../../src/saas/runtime/builtin-usage-bounds.js';
import { createDbCodexTrustedBoundProfileResolver } from '../../../src/saas/runtime/codex-bound-db-resolver.js';
import {
  type CodexTrustedBoundProfile,
  codexTrustedProfileDigest,
} from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';

/*
 * 方案1 (M1-D / R8) — the Codex billing-bound proof: the admission hold for a
 * Codex dispatch is priced by the ops-approved ledger row, never by deployment
 * ceilings or client claims. This is the cap-enforcement seam: whatever the
 * local byte-bound config would allow, a Codex request may only reserve the
 * reviewed profile's exact bounds, and only while the ledger admits its scope.
 */

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

const PROFILE_BOUNDS = {
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
} as const;

function profile(model: string, validFromMs: number, expiresAtMs: number): CodexTrustedBoundProfile {
  return {
    scope: {
      endpoint: CODEX_ENDPOINT,
      productId: 'codex-chatgpt',
      model,
      operation: 'responses',
      transport: 'http',
      continuationMode: 'full',
    },
    backendRevision: 'backend-rev-1',
    evidenceVersion: 'proof-v1',
    evidenceReference: 'ops-live-evidence-checklist-entry',
    validFromMs,
    expiresAtMs,
    bounds: PROFILE_BOUNDS,
  };
}

function row(profileValue: CodexTrustedBoundProfile) {
  return {
    digest: codexTrustedProfileDigest(profileValue),
    endpoint: profileValue.scope.endpoint,
    product_id: profileValue.scope.productId,
    model: profileValue.scope.model,
    operation: profileValue.scope.operation,
    transport: profileValue.scope.transport,
    continuation_mode: profileValue.scope.continuationMode,
    bounds: profileValue.bounds,
    backend_revision: profileValue.backendRevision,
    evidence_version: profileValue.evidenceVersion,
    evidence_reference: profileValue.evidenceReference,
    valid_from_ms: String(profileValue.validFromMs),
    expires_at_ms: String(profileValue.expiresAtMs),
  };
}

class LedgerFake implements SqlExecutor {
  rows: Record<string, unknown>[] = [];

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    if (sql.includes('FROM saas_codex_trusted_bound_profiles')) {
      return { rows: this.rows as Row[], rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

const PAYLOAD = Buffer.from(JSON.stringify({ model: 'gpt-5.2-codex', input: [], stream: true, store: false }));

function estimateWith(database: LedgerFake) {
  return async (model: string) => {
    const resolver = await createDbCodexTrustedBoundProfileResolver({
      database,
      expiryMarginMs: 5000,
      now: () => 2000,
    });
    const estimator = createBuiltinUsageUpperBoundEstimator({
      // Deployment ceilings are orders of magnitude above the reviewed
      // bounds: the hold must still equal the reviewed bounds.
      maxInputTokens: 10_000_000,
      maxOutputTokens: 100_000,
      codexProfileResolver: resolver,
    });
    return estimator.estimate({
      normalizedRequest: {
        providerId: 'openai-codex',
        providerProtocol: 'responses',
        providerOperation: 'responses',
        resolvedModel: model,
        productId: 'codex-chatgpt',
        upstreamTransport: 'http',
        continuationMode: 'full',
      },
      compiledPayloadBytes: PAYLOAD,
    } as never) as { bounds: typeof PROFILE_BOUNDS; trustedBoundEvidenceDigest: string | undefined };
  };
}

test('an approved ledger row prices the codex hold at exactly the reviewed bounds', async () => {
  const fake = new LedgerFake();
  const admitted = profile('gpt-5.2-codex', 1000, 60_000);
  fake.rows = [row(admitted)];
  const estimate = estimateWith(fake);

  const result = await estimate('gpt-5.2-codex');
  assert.ok(result);
  assert.deepEqual(result.bounds, PROFILE_BOUNDS);
  assert.equal(result.trustedBoundEvidenceDigest, codexTrustedProfileDigest(admitted));
});

test('codex estimates fail closed without an admitted scope or with an expiring profile', async () => {
  const fake = new LedgerFake();
  // Expiring: 4000ms remain at the fixed clock but the 5000ms margin
  // requires more, so the ledger must not admit it.
  fake.rows = [row(profile('gpt-5.2-codex', 1000, 6000))];
  const estimate = estimateWith(fake);
  await assert.rejects(() => estimate('gpt-5.2-codex'), /usage bound is unavailable/);

  // No approved row for this model at all.
  fake.rows = [row(profile('gpt-5.2-codex', 1000, 60_000))];
  await assert.rejects(() => estimate('gpt-5.2-codex-mini'), /usage bound is unavailable/);
});
