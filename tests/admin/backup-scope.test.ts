import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminMaintenance } from '../../src/admin/maintenance.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlError, ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('backup fails closed without telemetry and creates no falsely full manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-backup-scope-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'backup-scope-test');
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));
  const store = new ControlStore(dir);
  try {
    const control = new ControlService(configPath, store);
    const maintenance = new AdminMaintenance(control, store);
    await assert.rejects(
      maintenance.backup(new AbortController().signal),
      (error: unknown) =>
        error instanceof ControlError && error.code === 'TELEMETRY_UNAVAILABLE' && error.status === 503,
    );
    assert.deepEqual(readdirSync(join(dir, 'admin-backups')), []);

    const unopened = new SQLiteTelemetryStore(join(dir, 'unopened.sqlite'));
    await assert.rejects(
      new AdminMaintenance(control, store, unopened).backup(new AbortController().signal),
      (error: unknown) => error instanceof ControlError && error.code === 'TELEMETRY_UNAVAILABLE',
    );
    assert.deepEqual(readdirSync(join(dir, 'admin-backups')), []);

    const telemetry = new SQLiteTelemetryStore(join(dir, 'logs.sqlite'));
    await telemetry.init();
    try {
      const result = await new AdminMaintenance(control, store, telemetry).backup(new AbortController().signal);
      const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8')) as {
        scope: string;
        telemetrySha256: string;
      };
      assert.equal(result.scope, 'config-secrets-control-telemetry');
      assert.equal(manifest.scope, result.scope);
      assert.equal(
        manifest.telemetrySha256,
        createHash('sha256')
          .update(readFileSync(join(result.path, 'telemetry.sqlite')))
          .digest('hex'),
      );
    } finally {
      await telemetry.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
