import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { EGRESS_PROXIES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/107_egress_proxies.js';

// Static candidate/source assertions only, mirroring the 106/108 migration
// test family. No mock database, SQL evaluator, or claim of managed
// PostgreSQL acceptance.
const migration = EGRESS_PROXIES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('107 registers between the applied 106 head and the 108 forward', () => {
  assert.equal(migration.version, 107);
  assert.equal(migration.name, 'egress_proxies');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(107);
  assert.ok(index > 0, '107 is registered');
  assert.equal(registered[index - 1], 106, '107 lands directly after the 106 head');
  assert.equal(registered[index + 1], 108, '107 lands directly before the 108 forward');
  assert.equal(registered.at(-1), 116, 'the R6a, F1 and Gemini forwards follow the 108 head');
  assert.equal(registered.indexOf(107), registered.lastIndexOf(107));
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('107 pins the protocol whitelist and never stores credential columns', () => {
  assert.match(commands, /CREATE TABLE saas_egress_proxies \(/);
  assert.match(commands, /protocol text NOT NULL\s+CHECK \(protocol IN \('http', 'https', 'socks5', 'socks5h'\)\)/);
  assert.match(
    commands,
    /fallback_mode text NOT NULL DEFAULT 'none'\s+CHECK \(fallback_mode IN \('none', 'proxy', 'direct'\)\)/,
  );
  assert.match(commands, /auth_sealed_envelope jsonb/);
  // The envelope CHECK pins the KMS shape and refuses plaintext pairs.
  assert.match(commands, /\(auth_sealed_envelope ->> 'algorithm'\) = 'aes-256-gcm'/);
  assert.match(commands, /NOT \(auth_sealed_envelope \? 'username'\)/);
  assert.match(commands, /NOT \(auth_sealed_envelope \? 'password'\)/);
  // No plaintext credential columns ever exist on the table.
  assert.doesNotMatch(commands, /password text/i);
  assert.doesNotMatch(commands, /username text/i);
});

test('107 enforces the fallback shape and unique name', () => {
  assert.match(commands, /CONSTRAINT saas_egress_proxies_name_unique UNIQUE \(name\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_egress_proxies_no_self_backup\s+CHECK \(backup_proxy_id IS NULL OR backup_proxy_id <> id\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_egress_proxies_fallback_shape\s+CHECK \(\s+\(fallback_mode = 'proxy' AND backup_proxy_id IS NOT NULL\)\s+OR \(fallback_mode <> 'proxy' AND backup_proxy_id IS NULL\)\s+\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_egress_proxies_backup_fk\s+FOREIGN KEY \(backup_proxy_id\) REFERENCES saas_egress_proxies \(id\) ON DELETE SET NULL/,
  );
});

test('107 binds both account families with fail-closed FK semantics', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN egress_proxy_id uuid,\\s+ADD COLUMN proxy_fallback_origin_id uuid;`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_egress_proxy_fk\\s+FOREIGN KEY \\(egress_proxy_id\\) REFERENCES saas_egress_proxies \\(id\\) ON DELETE RESTRICT`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_proxy_fallback_origin_fk\\s+FOREIGN KEY \\(proxy_fallback_origin_id\\) REFERENCES saas_egress_proxies \\(id\\) ON DELETE SET NULL`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CREATE INDEX ${table}_egress_proxy_idx\\s+ON ${table} \\(egress_proxy_id\\)\\s+WHERE egress_proxy_id IS NOT NULL;`,
      ),
    );
  }
});

test('107 indexes expiry sweeps and probe quality reads', () => {
  assert.match(
    commands,
    /CREATE INDEX saas_egress_proxies_expires_at_idx\s+ON saas_egress_proxies \(expires_at\)\s+WHERE status = 'active' AND expires_at IS NOT NULL;/,
  );
  assert.match(commands, /CREATE INDEX saas_egress_proxies_backup_idx\s+ON saas_egress_proxies \(backup_proxy_id\);/);
  assert.match(
    commands,
    /last_probe_quality text\s+CHECK \(last_probe_quality IS NULL OR last_probe_quality IN \('ok', 'degraded', 'dead'\)\)/,
  );
});

test('107 changes no ACL, trigger, or function surface', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /INSERT INTO/i);
});
