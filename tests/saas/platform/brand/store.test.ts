import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { BRAND_SETTINGS_KEYS } from '../../../../src/saas/platform/brand/snapshot.js';
import {
  createCachedBrandSnapshotReader,
  PublicBrandSnapshotStore,
  startPublicBrandSnapshotWorker,
} from '../../../../src/saas/platform/brand/store.js';

/**
 * Batch 5 §5.2 OEM white-label: the snapshot data plane — materialization
 * composes the settings rows through the strict grammar and upserts the
 * single snapshot row (version increments), reads fail-open to the empty
 * snapshot on a missing row, the TTL cache serves the last good snapshot on
 * a failed refresh, and the periodic worker's cycle/refresh/close contract.
 * The fake database is the scripted-results style of
 * tests/saas/platform/settings/fakes.ts with a small stateful snapshot row.
 */

interface SnapshotRow {
  readonly snapshot: unknown;
  readonly version: number;
}

class FakeBrandDatabase {
  readonly statements: string[] = [];
  readonly settings = new Map<string, unknown>();
  snapshotRow: SnapshotRow | undefined;
  failSnapshotRead = false;
  failMaterialize = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const flat = sql.trim().replace(/\s+/g, ' ');
    this.statements.push(`${flat} :: ${values.join('|')}`);
    if (flat.includes('FROM saas_platform_settings')) {
      const wanted = values[0] as readonly string[];
      const rows = wanted
        .filter((key) => this.settings.has(key))
        .map((key) => ({ key, value: { value: this.settings.get(key) } }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (flat.includes('INSERT INTO saas_public_brand_settings')) {
      if (this.failMaterialize) throw new Error('snapshot storage unavailable');
      const snapshot = JSON.parse(String(values[0])) as Record<string, unknown>;
      const version = (this.snapshotRow?.version ?? 0) + 1;
      this.snapshotRow = { snapshot, version };
      return { rows: [{ version }] as Row[], rowCount: 1 };
    }
    if (flat.includes('FROM saas_public_brand_settings')) {
      if (this.failSnapshotRead) throw new Error('snapshot read failed');
      if (this.snapshotRow === undefined) return { rows: [], rowCount: 0 };
      return { rows: [this.snapshotRow as Row], rowCount: 1 };
    }
    throw new Error(`unhandled fake SQL: ${sql}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: (sql, values) => this.query(sql, values) });
  }
}

function createStore(): { fake: FakeBrandDatabase; store: PublicBrandSnapshotStore } {
  const fake = new FakeBrandDatabase();
  return { fake, store: new PublicBrandSnapshotStore({ database: fake as unknown as SaasDatabase }) };
}

test('materialize composes the brand settings subset and upserts version 1', async () => {
  const { fake, store } = createStore();
  fake.settings.set(BRAND_SETTINGS_KEYS.siteName, 'Acme Router');
  fake.settings.set(BRAND_SETTINGS_KEYS.siteLogo, 'https://cdn.oem.test/logo.png');
  fake.settings.set('saas.registration.mode', 'open'); // non-brand keys are excluded
  const version = await store.materialize();
  assert.equal(version, 1);
  assert.equal(fake.snapshotRow?.version, 1);
  assert.deepEqual(fake.snapshotRow?.snapshot, {
    siteName: 'Acme Router',
    siteSubtitle: '',
    siteLogo: 'https://cdn.oem.test/logo.png',
    apiBaseUrl: '',
    contactUrl: '',
    docUrl: '',
    customMenuItems: [],
    customEndpoints: [],
    customPages: [],
    frameAncestors: [],
  });
  // Round trip: read() re-validates the materialized row.
  const read = await store.read();
  assert.equal(read.siteName, 'Acme Router');
  assert.equal(read.siteLogo, 'https://cdn.oem.test/logo.png');
});

test('materialize increments the version on every cycle and empty settings materialize the empty snapshot', async () => {
  const { fake, store } = createStore();
  assert.equal(await store.materialize(), 1);
  assert.equal(await store.materialize(), 2);
  assert.equal(fake.snapshotRow?.version, 2);
  // The empty snapshot is materialized with all fields present (readers see
  // a stable shape), not as a bare {}.
  assert.deepEqual(fake.snapshotRow?.snapshot, {
    siteName: '',
    siteSubtitle: '',
    siteLogo: '',
    apiBaseUrl: '',
    contactUrl: '',
    docUrl: '',
    customMenuItems: [],
    customEndpoints: [],
    customPages: [],
    frameAncestors: [],
  });
  const read = await store.read();
  assert.equal(read.siteName, '');
  assert.equal(read.customPages.length, 0);
});

test('a corrupted settings row fails the materialization fail-closed and keeps the previous snapshot', async () => {
  const { fake, store } = createStore();
  fake.settings.set(BRAND_SETTINGS_KEYS.siteName, 'Acme Router');
  await store.materialize();
  fake.settings.set(BRAND_SETTINGS_KEYS.siteLogo, 'javascript:alert(1)');
  await assert.rejects(store.materialize(), /scheme is not allowed|must not/i);
  // The previous snapshot survives.
  assert.equal((await store.read()).siteName, 'Acme Router');
  assert.equal(fake.snapshotRow?.version, 1);
});

test('read returns the empty snapshot for a missing row and fails on a corrupted row', async () => {
  const { fake, store } = createStore();
  assert.deepEqual(await store.read(), {
    siteName: '',
    siteSubtitle: '',
    siteLogo: '',
    apiBaseUrl: '',
    contactUrl: '',
    docUrl: '',
    customMenuItems: [],
    customEndpoints: [],
    customPages: [],
    frameAncestors: [],
  });
  fake.snapshotRow = { snapshot: { siteLogo: 'javascript:alert(1)' }, version: 3 };
  await assert.rejects(store.read());
});

test('the cached reader serves within the TTL, fails open, and invalidates', async () => {
  const { fake, store } = createStore();
  let clock = 1_000;
  const errors: unknown[] = [];
  const reader = createCachedBrandSnapshotReader(store, {
    ttlMs: 15_000,
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  fake.settings.set(BRAND_SETTINGS_KEYS.siteName, 'Acme');
  await store.materialize();
  assert.equal((await reader.read()).siteName, 'Acme');
  const reads = fake.statements.filter((statement) => statement.includes('FROM saas_public_brand_settings')).length;
  // Inside the TTL: no new read.
  await reader.read();
  assert.equal(
    fake.statements.filter((statement) => statement.includes('FROM saas_public_brand_settings')).length,
    reads,
  );
  // A read failure inside the TTL still serves the cached snapshot.
  fake.failSnapshotRead = true;
  clock += 20_000;
  assert.equal((await reader.read()).siteName, 'Acme');
  assert.equal(errors.length, 1);
  // A read failure past the cached entry keeps serving the last good
  // snapshot (stale brand, never a broken console) and retries every read.
  clock += 20_000;
  assert.equal((await reader.read()).siteName, 'Acme');
  assert.equal(errors.length, 2);
  // Recovery + invalidate.
  fake.failSnapshotRead = false;
  reader.invalidate();
  assert.equal((await reader.read()).siteName, 'Acme');
});

test('the worker delays its first cycle, materializes on refresh, and validates its interval bounds', async () => {
  const { fake, store } = createStore();
  fake.settings.set(BRAND_SETTINGS_KEYS.siteName, 'Acme');
  const worker = startPublicBrandSnapshotWorker(store, { intervalMs: 5_000 });
  try {
    // No startup write: the first cycle waits for the interval so process
    // startup stays read-only (the saas-startup read-route contract).
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.snapshotRow, undefined);
    await worker.refresh();
    assert.equal(fake.snapshotRow?.version, 1);
    await worker.refresh();
    assert.equal(fake.snapshotRow?.version, 2);
    // A failed refresh rejects (the afterWrite hook logs it).
    fake.failMaterialize = true;
    await assert.rejects(worker.refresh());
    assert.equal(fake.snapshotRow?.version, 2);
  } finally {
    await worker.close();
  }
  assert.throws(() => startPublicBrandSnapshotWorker(store, { intervalMs: 1 }), RangeError);
  assert.throws(() => startPublicBrandSnapshotWorker(store, { intervalMs: 3_600_001 }), RangeError);
});
