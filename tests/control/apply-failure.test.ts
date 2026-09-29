import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';

test('persisted config reports degraded runtime when apply callback fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-apply-fail-'));
  const store = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), store, undefined, async () => {
    throw new Error('runtime reconcile failed');
  });
  try {
    const initial = await control.raw();
    const result = await control.commit({ ...initial, server: { ...initial.server, port: 15111 } }, 1, 'admin');
    assert.equal(result.persistedRevision, 2);
    assert.equal(result.effectiveRevision, 1);
    assert.match(result.applyError ?? '', /runtime reconcile failed/);
    assert.equal(control.applyError(), result.applyError);
    assert.equal((await control.raw()).revision, 2);
    const audit = store.db.prepare("SELECT action FROM audit_events WHERE action='config.apply_failed'").get();
    assert.ok(audit);
    const current = await control.raw();
    const deferred = await control.commit(
      {
        ...current,
        admin: { ...current.admin, enabled: false, publicAdminBaseUrl: 'http://127.0.0.1:15112' },
        server: { ...current.server, trustedProxyCidrs: ['127.0.0.1/32'] },
        storage: { ...current.storage, flushIntervalMs: 500 },
        quota: { ...current.quota, timezone: 'Asia/Shanghai' },
      },
      2,
      'admin',
    );
    assert.ok(deferred.restartRequiredFields.includes('admin.enabled'));
    assert.ok(deferred.restartRequiredFields.includes('admin.publicAdminBaseUrl'));
    assert.ok(deferred.restartRequiredFields.includes('server.trustedProxyCidrs'));
    assert.ok(deferred.restartRequiredFields.includes('storage.flushIntervalMs'));
    assert.equal(deferred.restartRequiredFields.includes('quota.timezone'), false);
    control.markExternallyDeferred(['admin.enabled'], 1);
    assert.equal(control.effectiveRevision(3), 1);
    control.markExternallyApplied(3);
    assert.equal(control.effectiveRevision(3), 3);
    assert.equal(control.applyError(), undefined);
    assert.deepEqual(control.restartRequiredFields(), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
