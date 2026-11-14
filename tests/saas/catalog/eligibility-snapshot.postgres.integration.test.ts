import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CATALOG_ELIGIBILITY_SNAPSHOT_SQL } from '../../../src/saas/catalog/eligibility-snapshot.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { ProviderEligibilityResult } from '../../../src/saas/catalog/types.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

test('catalog eligibility snapshot uses two restricted-role statements and sees revocation after a fence wait', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? 'requires disposable PostgreSQL role URLs' : false,
  timeout: 120_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  const fixture = await seedFixture(migrator, gateway, 'platform');
  const attempt = fixture.sent;
  assert.ok(attempt.providerId && attempt.productId && attempt.resolvedModel && attempt.endpoint);
  const input = {
    providerId: attempt.providerId,
    productId: attempt.productId,
    model: attempt.resolvedModel,
    endpoint: attempt.endpoint,
    credentialType: 'api-key',
    supplyMode: 'platform' as const,
    region: 'test',
    purpose: 'inference',
  };
  const catalog = new SaasCatalogService(gateway);
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const allowed = await gateway.transaction((tx) =>
    catalog.evaluateProviderEligibility(input, new Date(), {
      query: (sql, values = []) => {
        calls.push({ sql, values });
        return tx.query(sql, values);
      },
    }),
  );
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision !== 'allow') throw new Error('seeded catalog must allow');
  assert.equal(calls.length, 2, 'one fence statement, then one fresh snapshot');
  assert.match(calls[0].sql, /pg_advisory_xact_lock_shared/);
  assert.equal(calls[1].sql, CATALOG_ELIGIBILITY_SNAPSHOT_SQL);
  for (let version = 2; version <= 10; version++) {
    const registered = await new SaasCatalogService(migrator).registerProviderCapability({
      providerId: input.providerId,
      productId: input.productId,
      model: input.model,
      endpoint: input.endpoint,
      protocol: 'openai',
      supportLevel: 'supported',
      validationState: 'verified',
      evidenceVersion: 'snapshot-order-fixture',
      discoverySource: 'manual',
      evidenceReference: 'synthetic-catalog-integer-order',
      evidenceSha256: 'c'.repeat(64),
    });
    assert.equal(registered.version, version);
  }
  const latest = await catalog.evaluateProviderEligibility(input);
  assert.equal(latest.decision, 'allow');
  if (latest.decision === 'allow') assert.equal(latest.capability.version, 10, 'numeric version 10 must precede 2');
  const wire = await gateway.query<{ capability: { version: unknown }; rights: { version: unknown }[] }>(
    CATALOG_ELIGIBILITY_SNAPSHOT_SQL,
    [input.providerId, input.productId, input.model, input.endpoint],
  );
  assert.equal(typeof wire.rows[0].capability.version, 'string');
  assert.equal(wire.rows[0].capability.version, '10');
  assert.ok(wire.rows[0].rights.length > 0);
  assert.ok(wire.rows[0].rights.every((row) => typeof row.version === 'string'));

  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = () => {};
  const writerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const writer = migrator.transaction(async (tx) => {
    // Same product key and SQL as the real catalog reader, with the writer's
    // exclusive lock. The append-only revocation stays uncommitted until the reader waits.
    await tx.query(calls[0].sql.replace('pg_advisory_xact_lock_shared', 'pg_advisory_xact_lock'), calls[0].values);
    await tx.query(
      `INSERT INTO saas_provider_rights
      (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
       model_scope, endpoint_scope, effective_at, expires_at, approval_ref, status, evidence_ref, evidence_sha256, created_at)
      SELECT rights_id, version + 1, provider_id, product_id, credential_type, supply_mode, region, purpose,
             model_scope, endpoint_scope, effective_at, expires_at, approval_ref, 'revoked', evidence_ref, evidence_sha256, clock_timestamp()
        FROM saas_provider_rights WHERE rights_id = $1 AND version = $2`,
      [allowed.rights.rightsId, allowed.rights.version],
    );
    ready();
    await released;
  });
  let reader: Promise<ProviderEligibilityResult> | undefined;
  try {
    await Promise.race([
      writerReady,
      writer.then(() => {
        throw new Error('writer ended before barrier');
      }),
    ]);
    let identify: (pid: number) => void = () => {};
    const readerPid = new Promise<number>((resolve) => {
      identify = resolve;
    });
    reader = gateway.transaction(async (tx: SqlExecutor) => {
      const result = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      identify(result.rows[0].pid);
      return catalog.evaluateProviderEligibility(input, new Date(), tx);
    });
    const pid = await Promise.race([
      readerPid,
      reader.then(() => {
        throw new Error('reader ended before barrier');
      }),
    ]);
    let waiting = false;
    for (let index = 0; index < 250; index++) {
      const locks = await migrator.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted) AS waiting",
        [pid],
      );
      if (locks.rows[0].waiting) {
        waiting = true;
        break;
      }
      await delay(20);
    }
    assert.equal(waiting, true, 'the reader must actually wait on the uncommitted writer');
    release();
    await writer;
    const denied = await reader;
    assert.equal(denied.decision, 'deny');
    if (denied.decision === 'deny') assert.equal(denied.reason, 'rights_revoked');
  } finally {
    release();
    await Promise.allSettled([writer, ...(reader ? [reader] : [])]);
  }
});
