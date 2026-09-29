import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { selectPrice, type PricingProfile } from '../../src/telemetry/pricing.js';

test('legacy pricing profiles migrate additively into immutable explicit versions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-pricing-migration-'));
  const dbPath = path.join(dir, 'control.sqlite');
  const updatedAt = '2025-04-03T02:01:00.000Z';
  const legacyProfile = {
    id: 'legacy-profile', model: 'legacy-model', currency: 'USD', inputPerMillion: 1, outputPerMillion: 2,
  };
  const legacyDb = new Database(dbPath);
  legacyDb.exec('CREATE TABLE pricing (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)');
  legacyDb.prepare('INSERT INTO pricing VALUES(?,?,?)').run('legacy-profile', JSON.stringify(legacyProfile), updatedAt);
  legacyDb.close();

  const store = new ControlStore(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(defaultConfigV2(configPath, 'pricing-migration-test')));
  let origin = '';
  const app = createAdminServer({
    configPath,
    controlStore: store,
    bootstrapToken: 'pricing-test-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  try {
    const row = store.db.prepare('SELECT * FROM pricing_versions WHERE profile_id=?').get('legacy-profile') as {
      version_id: string;
      body: string;
      effective_from: string;
    } | undefined;
    assert.ok(row);
    assert.equal(row.version_id, 'pv_legacy_legacy-profile');
    assert.equal(row.effective_from, updatedAt);
    assert.deepEqual(JSON.parse(row.body), {
      ...legacyProfile, versionId: row.version_id, effectiveFrom: updatedAt,
    });
    assert.equal(store.db.prepare('SELECT body FROM pricing WHERE id=?').get('legacy-profile') !== undefined, true);
    assert.throws(
      () => store.db.prepare('UPDATE pricing_versions SET body=? WHERE version_id=?').run('{}', row.version_id),
      /pricing versions are immutable/,
    );

    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/admin/api/v1`;
    const raw = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const bootstrap = await raw('/bootstrap', 'POST', {
      token: 'pricing-test-token', name: 'admin', password: 'secure-password-123',
    });
    assert.equal(bootstrap.status, 201);
    const login = await raw('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const loginBody = await login.json() as { data: { csrfToken: string } };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const auth = { cookie, origin, 'x-csrf-token': loginBody.data.csrfToken };
    const patched = await raw('/pricing/legacy-profile', 'PATCH', {
      inputPerMillion: '9.5', effectiveFrom: '2026-01-01T00:00:00Z',
    }, auth);
    assert.equal(patched.status, 200);

    const versions = store.db.prepare(`SELECT v.version_id,v.body,v.effective_from,s.sequence FROM pricing_versions v
      JOIN pricing_version_sequence s USING(version_id) WHERE v.profile_id=? ORDER BY s.sequence`)
      .all('legacy-profile') as Array<{ version_id: string; body: string; effective_from: string; sequence: number }>;
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.version_id, row.version_id);
    assert.equal(JSON.parse(versions[0]!.body).inputPerMillion, 1);
    assert.equal(JSON.parse(versions[1]!.body).inputPerMillion, '9.5');
    assert.ok(versions[1]!.sequence > versions[0]!.sequence);
    const selectable = versions.map((version) => ({
      ...(JSON.parse(version.body) as PricingProfile), versionId: version.version_id, versionSequence: version.sequence,
    }));
    assert.equal(selectPrice(selectable, 'legacy-model', '', '', Date.parse(updatedAt))?.versionId, row.version_id);
    assert.equal(selectPrice(selectable, 'legacy-model', '', '', Date.parse('2026-02-01T00:00:00Z'))?.versionId, versions[1]?.version_id);
  } finally {
    await app.close();
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
