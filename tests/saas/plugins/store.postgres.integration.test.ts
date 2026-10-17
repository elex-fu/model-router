import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { PLUGIN_SYSTEM_SAAS_MIGRATION } from '../../../src/saas/db/migrations/128_plugin_system.js';
import { verifyPluginHostRuntimePrivileges } from '../../../src/saas/db/plugin-host-privileges.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { PostgresPluginStore } from '../../../src/saas/plugins/store.js';
import type { PluginManifest } from '../../../src/saas/plugins/types.js';

/**
 * Batch-5 §5.1 plugin system store gate on the real disposable PostgreSQL
 * database (the 121/122 postgres-integration gate pattern): migration 128's
 * tables exist and enforce, and the full PostgresPluginStore contract
 * (upsert/replace refusal, CAS state transitions, runtime-healthy gating,
 * bindings, KV TTL + LIKE escaping, cascade delete) runs against live SQL
 * as the migrator (the owner of everything in the disposable target).
 *
 * The final test connects as the dedicated plugin-host role (created by
 * deploy/managed-saas-plugin-host-role-grants.sql) and verifies both the
 * fail-closed privilege probe and the positive/negative access contract.
 */
const REQUIRED = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED';
const MIGRATOR_URL_ENV = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL';
const migratorUrl = process.env[MIGRATOR_URL_ENV]?.trim();
const skip =
  process.env[REQUIRED] !== '1' && !migratorUrl
    ? `set ${REQUIRED}=1 and ${MIGRATOR_URL_ENV} for the plugin-store real-PG gate`
    : false;

function disposableMigratorUrl(): string {
  assert.ok(migratorUrl, `${MIGRATOR_URL_ENV} is required for the plugin-store real-PG gate`);
  const parsed = new URL(migratorUrl);
  assert.equal(
    decodeURIComponent(parsed.username),
    'model_router_saas_migrator',
    `${MIGRATOR_URL_ENV} must use the designated migrator identity`,
  );
  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  assert.ok(
    (['127.0.0.1', '[::1]'].includes(host) && Number.isInteger(port) && port > 0 && port <= 65_535) ||
      (host === 'postgres' && port === 5432 && database === 'model_router_saas_ci'),
    'the migrator URL must target the designated CI or an explicit disposable loopback database',
  );
  return migratorUrl;
}

function pluginHostUrlFor(migrator: string): string {
  const parsed = new URL(migrator);
  parsed.username = 'model_router_saas_plugin_host';
  return parsed.toString();
}

/** sha256(name \0 sql) — the migrate.ts ledger checksum contract. */
function migrationChecksum(): string {
  return createHash('sha256')
    .update(PLUGIN_SYSTEM_SAAS_MIGRATION.name)
    .update('\0')
    .update(PLUGIN_SYSTEM_SAAS_MIGRATION.sql)
    .digest('hex');
}

async function ensureMigration128Applied(migrator: SaasDatabase): Promise<void> {
  const applied = await migrator.query<{ readonly version: number }>(
    'SELECT version FROM model_router_saas.saas_schema_migrations WHERE version = 128',
  );
  if (applied.rows.length === 1) {
    assert.equal(applied.rows[0]?.version, 128);
    return;
  }
  // The disposable target is shared across capability-parity worktrees, so a
  // full runSaasMigrations here may legitimately refuse on a not-yet-landed
  // parallel migration (the unknown-version guard). Applying migration 128
  // alone under its own transaction preserves the exact ledger checksum the
  // migrate helper would have written.
  await migrator.transaction(async (tx) => {
    await tx.query(PLUGIN_SYSTEM_SAAS_MIGRATION.sql);
    await tx.query(
      'INSERT INTO model_router_saas.saas_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [PLUGIN_SYSTEM_SAAS_MIGRATION.version, PLUGIN_SYSTEM_SAAS_MIGRATION.name, migrationChecksum()],
    );
  });
}

function testManifest(id: string): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Plugin Store Fixture',
    version: '1.2.3',
    description: 'integration fixture manifest',
    author: 'fixture',
    requires: { modelRouter: '0.1.0', pluginProtocol: 1, transportApi: 1 },
    capabilities: [{ id: 'claude.oauth.outbound_transport.v1' }],
    entrypoint: 'dist/index.js',
    files: { 'dist/index.js': 'fixture entrypoint bytes' },
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface StoreFixture {
  readonly pluginKey: string;
  readonly manifest: PluginManifest;
  readonly binarySha256: string;
  readonly artifactData: Uint8Array;
  readonly artifactSha256: string;
}

function storeFixture(): StoreFixture {
  const pluginKey = `plugin-store-${randomUUID()}`;
  const manifest = testManifest(pluginKey);
  const artifactData = new TextEncoder().encode(`signed-package:${pluginKey}`);
  return {
    pluginKey,
    manifest,
    binarySha256: sha256Hex(artifactData),
    artifactData,
    artifactSha256: sha256Hex(artifactData),
  };
}

test('PostgresPluginStore holds the CAS/binding/KV contract on live PostgreSQL', { skip }, async (t) => {
  const migrator = createSaasDatabase({ connectionString: disposableMigratorUrl(), max: 2 });
  try {
    await ensureMigration128Applied(migrator);
    // Shared-target hygiene: the partial unique index enforces ONE enabled
    // binding per capability scope database-wide, so leftover enabled
    // bindings from a prior run of this fixture would collide with this
    // run's fresh installations. Remove only this fixture's rows (the
    // binding cascade rides the FK).
    await migrator.query(
      "DELETE FROM model_router_saas.saas_plugin_installations WHERE plugin_key LIKE 'plugin-store-%'",
    );
    const store = new PostgresPluginStore({ database: migrator });

    await t.test('upsert → list → getInstallation round-trip', async () => {
      const fixture = storeFixture();
      const installed = await store.upsertInstallation({
        pluginKey: fixture.pluginKey,
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        description: fixture.manifest.description,
        author: fixture.manifest.author,
        manifest: fixture.manifest,
        manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
        entrypointPath: fixture.manifest.entrypoint,
        binarySha256: fixture.binarySha256,
        signatureStatus: 'trusted',
        artifactData: fixture.artifactData,
        artifactSha256: fixture.artifactSha256,
        installedBy: null,
      });
      assert.equal(installed.state, 'disabled');
      assert.equal(installed.pluginKey, fixture.pluginKey);
      assert.equal(installed.signatureStatus, 'trusted');
      assert.equal(installed.configJson, null);
      assert.equal(installed.enabledAt, null);
      assert.deepEqual(new Uint8Array(installed.artifactData), fixture.artifactData);
      assert.deepEqual(installed.manifest.capabilities, [{ id: 'claude.oauth.outbound_transport.v1' }]);

      const listed = await store.listInstallations();
      const row = listed.find((candidate) => candidate.pluginKey === fixture.pluginKey);
      assert.ok(row, 'the fresh installation must appear in listInstallations');
      assert.equal(row.binarySha256, fixture.binarySha256);

      const fetched = await store.getInstallation(fixture.pluginKey);
      assert.ok(fetched);
      assert.equal(fetched.id, installed.id);
      assert.equal(fetched.artifactSha256, fixture.artifactSha256);
      // Fresh installs seed their manifest-derived bindings disabled.
      const bindings = (await store.listBindings()).filter((binding) => binding.installationId === installed.id);
      assert.deepEqual(
        bindings.map((binding) => [
          binding.pluginKey,
          binding.capability,
          binding.platform,
          binding.accountType,
          binding.enabled,
          binding.rolloutPercent,
        ]),
        [[fixture.pluginKey, 'claude.oauth.outbound_transport.v1', 'claude', 'oauth', false, 100]],
      );
    });

    await t.test('CAS state transitions; stale expectations return null, never throw', async () => {
      const fixture = storeFixture();
      const installed = await store.upsertInstallation({
        pluginKey: fixture.pluginKey,
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        description: '',
        author: '',
        manifest: fixture.manifest,
        manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
        entrypointPath: fixture.manifest.entrypoint,
        binarySha256: fixture.binarySha256,
        signatureStatus: 'unsigned',
        artifactData: fixture.artifactData,
        artifactSha256: fixture.artifactSha256,
        installedBy: null,
      });

      const starting = await store.updateInstallationState({
        id: installed.id,
        expectedState: 'disabled',
        expectedBinarySha256: fixture.binarySha256,
        state: 'starting',
      });
      assert.ok(starting);
      assert.equal(starting.state, 'starting');

      // Stale expectedState and stale binary hash are benign conflicts.
      assert.equal(
        await store.updateInstallationState({
          id: installed.id,
          expectedState: 'disabled',
          expectedBinarySha256: fixture.binarySha256,
          state: 'enabled',
        }),
        null,
      );
      assert.equal(
        await store.updateInstallationState({
          id: installed.id,
          expectedState: 'starting',
          expectedBinarySha256: `${'0'.repeat(64)}`,
          state: 'enabled',
        }),
        null,
      );
      // null expectedState matches any current state.
      const errored = await store.updateInstallationState({
        id: installed.id,
        expectedState: null,
        expectedBinarySha256: fixture.binarySha256,
        state: 'error',
        lastError: 'fixture crash',
      });
      assert.ok(errored);
      assert.equal(errored.state, 'error');
      assert.equal(errored.lastError, 'fixture crash');
      // Non-serving transitions clear enabled_at.
      assert.equal(errored.enabledAt, null);
    });

    await t.test('markRuntimeHealthy requires a starting/error/disabled row and an enabled binding', async () => {
      const fixture = storeFixture();
      const installed = await store.upsertInstallation({
        pluginKey: fixture.pluginKey,
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        description: '',
        author: '',
        manifest: fixture.manifest,
        manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
        entrypointPath: fixture.manifest.entrypoint,
        binarySha256: fixture.binarySha256,
        signatureStatus: 'trusted',
        artifactData: fixture.artifactData,
        artifactSha256: fixture.artifactSha256,
        installedBy: null,
      });
      await store.updateInstallationState({
        id: installed.id,
        expectedState: 'disabled',
        expectedBinarySha256: fixture.binarySha256,
        state: 'starting',
      });

      // No enabled binding yet: the runtime cannot serve traffic.
      assert.equal(
        await store.markRuntimeHealthy({ id: installed.id, expectedBinarySha256: fixture.binarySha256 }),
        false,
      );

      await store.replaceBindings({
        installationId: installed.id,
        bindings: [
          {
            capability: 'claude.oauth.outbound_transport.v1',
            platform: 'claude',
            accountType: 'oauth',
            enabled: true,
            rolloutPercent: 100,
          },
        ],
      });
      assert.equal(
        await store.markRuntimeHealthy({ id: installed.id, expectedBinarySha256: fixture.binarySha256 }),
        true,
      );
      const healthy = await store.getInstallation(fixture.pluginKey);
      assert.ok(healthy);
      assert.equal(healthy.state, 'enabled');
      assert.ok(healthy.enabledAt);
      assert.equal(healthy.lastError, '');
      // Already enabled: the CAS window is closed (benign).
      assert.equal(
        await store.markRuntimeHealthy({ id: installed.id, expectedBinarySha256: fixture.binarySha256 }),
        false,
      );
      // Release the capability scope for the later subtests (the partial
      // unique index is database-wide).
      assert.equal(await store.deleteInstallation(installed.id), true);
    });

    await t.test(
      'upsertInstallation refuses to replace a live installation, then replaces a disabled one',
      async () => {
        const fixture = storeFixture();
        const upsertInput = {
          pluginKey: fixture.pluginKey,
          name: fixture.manifest.name,
          version: fixture.manifest.version,
          description: '',
          author: '',
          manifest: fixture.manifest,
          manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
          entrypointPath: fixture.manifest.entrypoint,
          binarySha256: fixture.binarySha256,
          signatureStatus: 'trusted' as const,
          artifactData: fixture.artifactData,
          artifactSha256: fixture.artifactSha256,
          installedBy: null,
        };
        const installed = await store.upsertInstallation(upsertInput);
        await store.replaceBindings({
          installationId: installed.id,
          bindings: [
            {
              capability: 'claude.oauth.outbound_transport.v1',
              platform: 'claude',
              accountType: 'oauth',
              enabled: true,
              rolloutPercent: 50,
            },
          ],
        });
        await store.updateInstallationState({
          id: installed.id,
          expectedState: 'disabled',
          expectedBinarySha256: fixture.binarySha256,
          state: 'starting',
        });
        await store.markRuntimeHealthy({ id: installed.id, expectedBinarySha256: fixture.binarySha256 });

        // Replace while enabled (and while an enabled binding exists).
        await assert.rejects(store.upsertInstallation(upsertInput), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { readonly code?: unknown }).code, 'plugin_replace_forbidden');
          return true;
        });

        // Disable (state AND binding — the store refuses a replace while an
        // enabled binding exists), then the same upload replaces content.
        await store.updateInstallationState({
          id: installed.id,
          expectedState: 'enabled',
          expectedBinarySha256: fixture.binarySha256,
          state: 'disabled',
        });
        await store.replaceBindings({
          installationId: installed.id,
          bindings: [
            {
              capability: 'claude.oauth.outbound_transport.v1',
              platform: 'claude',
              accountType: 'oauth',
              enabled: false,
              rolloutPercent: 100,
            },
          ],
        });
        const nextArtifact = new TextEncoder().encode(`signed-package-v2:${fixture.pluginKey}`);
        const replaced = await store.upsertInstallation({
          ...upsertInput,
          version: '2.0.0',
          binarySha256: sha256Hex(nextArtifact),
          artifactData: nextArtifact,
          artifactSha256: sha256Hex(nextArtifact),
        });
        assert.equal(replaced.id, installed.id);
        assert.equal(replaced.version, '2.0.0');
        assert.equal(replaced.state, 'disabled');
        assert.equal(replaced.enabledAt, null);
        const bindings = (await store.listBindings()).filter((binding) => binding.installationId === installed.id);
        assert.deepEqual(
          bindings.map((binding) => binding.enabled),
          [false],
        );
      },
    );

    await t.test('KV set/get/list/delete with TTL expiry and LIKE escaping', async () => {
      const fixture = storeFixture();
      const pluginKey = fixture.pluginKey;
      assert.equal(await store.kvGet(pluginKey, 'state', 'counter'), null);

      await store.kvSet(pluginKey, 'state', 'counter', '42', null);
      const entry = await store.kvGet(pluginKey, 'state', 'counter');
      assert.ok(entry);
      assert.equal(entry.value, '42');
      assert.equal(entry.expiresAt, null);

      // Prefix listing is literal: 'foo.' does not match 'foo_bar', and an
      // underscore in the prefix must not act as a LIKE wildcard.
      await store.kvSet(pluginKey, 'state', 'foo.bar', 'a', null);
      await store.kvSet(pluginKey, 'state', 'foo_bar', 'b', null);
      await store.kvSet(pluginKey, 'state', 'alpha_beta', 'c', null);
      await store.kvSet(pluginKey, 'state', 'alphaxbeta', 'd', null);
      assert.deepEqual(await store.kvList(pluginKey, 'state', 'foo.', 10), ['foo.bar']);
      assert.deepEqual(await store.kvList(pluginKey, 'state', 'alpha_', 10), ['alpha_beta']);
      assert.deepEqual(await store.kvList(pluginKey, 'state', 'counter', 10), ['counter']);
      assert.deepEqual(await store.kvList(pluginKey, 'state', '', 100).then((keys) => keys.sort()), [
        'alpha_beta',
        'alphaxbeta',
        'counter',
        'foo.bar',
        'foo_bar',
      ]);

      // Upsert overwrites; delete removes exactly one key.
      await store.kvSet(pluginKey, 'state', 'counter', '43', null);
      assert.equal((await store.kvGet(pluginKey, 'state', 'counter'))?.value, '43');
      assert.equal(await store.kvDelete(pluginKey, 'state', 'foo.bar'), true);
      assert.equal(await store.kvGet(pluginKey, 'state', 'foo.bar'), null);
      assert.equal(await store.kvDelete(pluginKey, 'state', 'foo.bar'), false);

      // TTL rows expire by predicate.
      await store.kvSet(pluginKey, 'state', 'ephemeral', 'gone', 1);
      assert.ok(await store.kvGet(pluginKey, 'state', 'ephemeral'));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(await store.kvGet(pluginKey, 'state', 'ephemeral'), null);

      // App-side limits mirror the CHECK charset and the 256 KiB cap.
      await assert.rejects(store.kvSet(pluginKey, 'bad namespace', 'k', 'v', null), (error: unknown) => {
        assert.equal((error as { readonly code?: unknown }).code, 'kv_name_invalid');
        return true;
      });
      await assert.rejects(store.kvSet(pluginKey, 'state', 'bad key!', 'v', null), (error: unknown) => {
        assert.equal((error as { readonly code?: unknown }).code, 'kv_name_invalid');
        return true;
      });
      await assert.rejects(
        store.kvSet(pluginKey, 'state', 'big', 'a'.repeat(256 * 1024 + 1), null),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, 'kv_value_too_large');
          return true;
        },
      );
    });

    await t.test('deleteInstallation cascades the binding rows', async () => {
      const fixture = storeFixture();
      const installed = await store.upsertInstallation({
        pluginKey: fixture.pluginKey,
        name: fixture.manifest.name,
        version: fixture.manifest.version,
        description: '',
        author: '',
        manifest: fixture.manifest,
        manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
        entrypointPath: fixture.manifest.entrypoint,
        binarySha256: fixture.binarySha256,
        signatureStatus: 'trusted',
        artifactData: fixture.artifactData,
        artifactSha256: fixture.artifactSha256,
        installedBy: null,
      });
      assert.equal(await store.deleteInstallation(installed.id), true);
      assert.equal(await store.deleteInstallation(installed.id), false);
      assert.equal(await store.getInstallation(fixture.pluginKey), null);
      const bindings = (await store.listBindings()).filter((binding) => binding.installationId === installed.id);
      assert.deepEqual(bindings, []);
    });
  } finally {
    await migrator.close();
  }
});

test('the dedicated plugin-host role passes its fail-closed probe and holds exactly its access contract', {
  skip,
}, async () => {
  const migratorUrlValue = disposableMigratorUrl();
  const migrator = createSaasDatabase({ connectionString: migratorUrlValue, max: 2 });
  const pluginHost = createSaasDatabase({ connectionString: pluginHostUrlFor(migratorUrlValue), max: 2 });
  try {
    await ensureMigration128Applied(migrator);
    // The workload the plugin host converges from: one installation with
    // its stored signed package bytes.
    const store = new PostgresPluginStore({ database: migrator });
    const fixture = storeFixture();
    await store.upsertInstallation({
      pluginKey: fixture.pluginKey,
      name: fixture.manifest.name,
      version: fixture.manifest.version,
      description: '',
      author: '',
      manifest: fixture.manifest,
      manifestSha256: sha256Hex(JSON.stringify(fixture.manifest)),
      entrypointPath: fixture.manifest.entrypoint,
      binarySha256: fixture.binarySha256,
      signatureStatus: 'trusted',
      artifactData: fixture.artifactData,
      artifactSha256: fixture.artifactSha256,
      installedBy: null,
    });

    // Fail-closed probe: exact column surface, single table DELETE, no
    // broad grants, no sequences, no routines, no ownership.
    await verifyPluginHostRuntimePrivileges(pluginHost);

    // Positive: the replica re-verify read (artifact bytes) works.
    const artifact = await pluginHost.query<{ readonly plugin_key?: unknown; readonly artifact_data?: unknown }>(
      'SELECT plugin_key, artifact_data FROM saas_plugin_installations WHERE plugin_key = $1',
      [fixture.pluginKey],
    );
    assert.equal(artifact.rows.length, 1);
    assert.ok(artifact.rows[0]?.artifact_data);

    // Positive: the KV host service is PG-backed for this role.
    await pluginHost.query(
      `INSERT INTO saas_plugin_kv (plugin_key, namespace, key, value, expires_at, updated_at)
       VALUES ($1, 'probe', 'alive', 'yes', NULL, now())
       ON CONFLICT (plugin_key, namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [fixture.pluginKey],
    );
    const kv = await pluginHost.query<{ readonly value?: unknown }>(
      "SELECT value FROM saas_plugin_kv WHERE plugin_key = $1 AND namespace = 'probe' AND key = 'alive'",
      [fixture.pluginKey],
    );
    assert.equal(kv.rows[0]?.value, 'yes');
    assert.equal(await store.kvDelete(fixture.pluginKey, 'probe', 'alive'), true);

    // Negative: no billing table access (insufficient_privilege).
    await assert.rejects(pluginHost.query('SELECT id FROM saas_billing_groups'), (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, '42501');
      return true;
    });
  } finally {
    await migrator.close();
    await pluginHost.close();
  }
});
