import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/types.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';

test('legacy plaintext key migrates to encrypted store and plaintext backup is secured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-migrate-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ...DEFAULT_CONFIG,
      upstreams: [
        {
          name: 'local',
          provider: 'custom',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKeys: ['legacy-plaintext-key'],
          models: ['qwen2.5-coder:7b'],
          enabled: true,
          authMode: 'bearer',
          policy: { allowInsecureHttp: true },
        },
      ],
    }),
  );
  const store = new ControlStore(dir);
  try {
    const control = new ControlService(configPath, store);
    const migrated = await control.raw();
    assert.equal(migrated.schemaVersion, 2);
    const credential = migrated.upstreams[0].credentials[0];
    assert.equal(credential.secret.type, 'secret');
    if (credential.secret.type === 'secret')
      assert.equal(store.secrets.get(credential.secret.id), 'legacy-plaintext-key');
    assert.equal(readFileSync(configPath, 'utf8').includes('legacy-plaintext-key'), false);
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith('.bak')),
      false,
    );
    const audit = store.db.prepare("SELECT detail FROM audit_events WHERE action='config.v1_encrypted_backup'").get() as
      | { detail: string }
      | undefined;
    assert.ok(audit);
    const backupId = `backup_${(JSON.parse(audit.detail) as { label: string }).label}`;
    assert.match(store.secrets.get(backupId) ?? '', /legacy-plaintext-key/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
