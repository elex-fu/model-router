import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresPreparationCapacityAdapter } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import {
  canonicalPreparedRequestEvidencePayload,
  type PreparedRequestEvidenceInput,
  type PreparedRequestEvidenceRecord,
  type PreparedRequestEvidenceServiceOptions,
  SaasPreparedRequestEvidenceService,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import { seedFixture } from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, createAdmissionHarness } from './admission-bench-fixture.js';

/** Caller owns a disposable migrated database with the exact restricted roles. */
export async function evidenceAuthorityFixture(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  mode: 'byok' | 'platform',
  options: { readonly evidenceTtlMs?: number; readonly rollbackRegistration?: boolean } = {},
) {
  const evidenceTtlMs = options.evidenceTtlMs === undefined ? 5 * 60_000 : options.evidenceTtlMs;
  assert.ok(Number.isSafeInteger(evidenceTtlMs) && evidenceTtlMs > 0, 'evidence TTL must be a positive safe integer');
  assert.ok(Number.isFinite(new Date(Date.now() + evidenceTtlMs).getTime()), 'evidence deadline must be finite');
  const original = await seedFixture(migrator, gateway, mode);
  const pool = mode === 'platform' ? await alignPlatformPool(migrator, original) : undefined;
  const harness = await createAdmissionHarness(migrator, gateway, original, mode, pool);
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const label = `evidence-authority:${requestId}`;
  const built = harness.plan.command(requestId, attemptId, label);
  const candidate = built.request.initialAttempt;
  assert.ok(candidate && typeof candidate === 'object');
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'evidence-authority-pg-only';
  const serviceOptions: PreparedRequestEvidenceServiceOptions = {
    trustedVerifierPublicKeys: new Map([[keyId, keys.publicKey]]),
  };
  const evidenceService = new SaasPreparedRequestEvidenceService(gateway, serviceOptions);
  const usage = {
    inputTotalUpperBound: '1',
    inputUncachedUpperBound: '1',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '1',
    reasoningOutputUpperBound: '0',
    feasibleInputBuckets: ['input'],
  };
  let registered: PreparedRequestEvidenceRecord | undefined;
  const registrationDatabase = options.rollbackRegistration ? rollbackEvidenceDatabase(gateway) : gateway;
  const input = await registrationDatabase.transaction(async (tx) => {
    const admitted = await harness.admit(tx, requestId, attemptId, label);
    assert.equal(admitted.kind, 'created');
    if (admitted.kind !== 'created') throw new Error('fresh evidence authority fixture admission required');
    const capacity = await new PostgresPreparationCapacityAdapter().reserve(tx, {
      tenantId: original.tenantId,
      projectId: original.projectId,
      proxyKeyId: original.keyId,
      requestId,
      attemptId,
      supplyMode: mode,
      payloadBounds: usage,
      idempotencyScopeKey: sha256Hex(`evidence-authority-idem:${requestId}`),
      requestFingerprint: String(built.request.requestFingerprint),
      requestFingerprintVersion: 'canonical-v1',
    });
    assert.equal(capacity.decision, 'allow');
    const deadline = new Date(Date.now() + evidenceTtlMs);
    const unsigned = {
      ...built.request,
      ...candidate,
      evidenceId: randomUUID(),
      requestId,
      attemptId,
      attemptOrdinal: 1,
      usage,
      maxHoldCurrency: mode === 'platform' ? 'USD' : null,
      maxHoldMinorUnits: admitted.reservation?.amountMinorUnits ?? '0',
      dispatchDeadline: deadline,
      expiresAt: deadline,
      retryBudget: 0,
      verifierKeyId: keyId,
      signatureBase64: '',
      audit: { actorUserId: null, entryPoint: 'evidence-authority-pg-only', requestId },
    } as unknown as PreparedRequestEvidenceInput;
    const signed: PreparedRequestEvidenceInput = {
      ...unsigned,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalPreparedRequestEvidencePayload(unsigned)),
        keys.privateKey,
      ).toString('base64'),
    };
    registered = await evidenceService.register(signed, { executor: tx });
    return signed;
  });
  assert.ok(input.evidenceId);
  assert.ok(registered);
  return { original, input, registered, options: serviceOptions, evidenceService, evidenceId: input.evidenceId };
}

/** Roll back real claim writes after observing their result, for repeatable measurements. */
export function rollbackEvidenceDatabase(
  gateway: SaasDatabase,
  observe?: (sql: string, durationMs: number) => void,
): SaasDatabase {
  return {
    ...gateway,
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const rollback = new Error('rollback isolated evidence authority observation');
      let value: T | undefined;
      try {
        await gateway.transaction(async (tx) => {
          value = await work({
            async query<Row>(sql: string, values?: readonly unknown[]) {
              const startedAt = performance.now();
              try {
                return await tx.query<Row>(sql, values);
              } finally {
                observe?.(sql, performance.now() - startedAt);
              }
            },
          });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return value as T;
    },
  };
}
