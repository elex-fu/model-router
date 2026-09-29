import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigServiceV2 } from '../../src/config/v2-service.js';
import { ControlService, configChecksum } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mr-config-journal-'));
  const configPath = join(dir, 'config.json');
  const store = new ControlStore(dir);
  const configService = new ConfigServiceV2(configPath, {
    storeSecret: async (value) => { const id = `test_${Math.random()}`; store.secrets.put(id, value); return id; },
    hasSecret: (id) => store.secrets.has(id),
    backupLegacy: async (raw, label) => { store.secrets.put(`backup_${label}`, raw); },
  });
  return { dir, configPath, store, configService };
}

function configService(path: string, store: ControlStore) {
  return new ConfigServiceV2(path, {
    storeSecret: async (value) => { const id = `test_${Math.random()}`; store.secrets.put(id, value); return id; },
    hasSecret: (id) => store.secrets.has(id),
    backupLegacy: async (raw, label) => { store.secrets.put(`backup_${label}`, raw); },
  });
}

function legacyConfig() {
  return { server: {}, proxyKeys: [], upstreams: [{ name: 'legacy', provider: 'custom', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKeys: ['plaintext-must-stay-private'], models: [], enabled: false }] };
}

test('legacy migration records only V2 history and an idempotent commit audit', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify(legacyConfig()));
    const control = new ControlService(f.configPath, f.store, f.configService);
    const migrated = await control.raw();
    assert.equal(migrated.revision, 1);
    const row = f.store.db.prepare('SELECT actor_id,state FROM config_journal').get() as { actor_id: string; state: string };
    assert.deepEqual(row, { actor_id: 'migration', state: 'committed' });
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS count FROM config_history').get() as { count: number }).count, 1);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='config.commit'").get() as { count: number }).count, 1);
    const persisted = JSON.stringify({
      history: f.store.db.prepare('SELECT config_json FROM config_history').all(),
      journal: f.store.db.prepare('SELECT * FROM config_journal').all(),
      audit: f.store.db.prepare('SELECT detail FROM audit_events').all(),
    });
    assert.doesNotMatch(persisted, /plaintext-must-stay-private|apiKeys/i);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).schemaVersion, 2);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pre-rename migration failure is aborted and safely retried', async () => {
  const f = fixture();
  try {
    const legacy = legacyConfig();
    writeFileSync(f.configPath, JSON.stringify(legacy));
    const first = new ControlService(f.configPath, f.store, f.configService, undefined, { beforeConfigRename: () => { throw new Error('before rename'); } });
    await assert.rejects(first.raw(), /before rename/);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).schemaVersion, undefined);
    const retry = new ControlService(f.configPath, f.store, configService(f.configPath, f.store));
    assert.equal((await retry.raw()).schemaVersion, 2);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM config_journal WHERE state='aborted'").get() as { count: number }).count, 1);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM config_journal WHERE state='committed'").get() as { count: number }).count, 1);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('post-rename migration crash is finalized by startup recovery', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify(legacyConfig()));
    const first = new ControlService(f.configPath, f.store, f.configService, undefined, { afterConfigRename: () => { throw new Error('simulated crash'); } });
    await assert.rejects(first.raw(), /simulated crash/);
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const recovery = new ControlService(f.configPath, f.store, configService(f.configPath, f.store));
    recovery.reconcileStartup(disk);
    recovery.reconcileStartup(disk);
    assert.equal((f.store.db.prepare("SELECT state FROM config_journal WHERE actor_id='migration'").get() as { state: string }).state, 'committed');
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='config.commit'").get() as { count: number }).count, 1);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('legacy checksum conflict refuses migration retry', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify(legacyConfig()));
    const first = new ControlService(f.configPath, f.store, f.configService, undefined, { beforeConfigRename: () => { throw new Error('before rename'); } });
    await assert.rejects(first.raw(), /before rename/);
    writeFileSync(f.configPath, JSON.stringify({ ...legacyConfig(), changed: true }));
    const retry = new ControlService(f.configPath, f.store, configService(f.configPath, f.store));
    await assert.rejects(retry.raw(), /migration checksum conflict/);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).changed, true);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pre-rename failure leaves JSON unchanged and startup aborts prepared row', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService, undefined, {
      beforeConfigRename: () => {
        throw new Error('injected before rename');
      },
    });
    const initial = await control.raw();
    await assert.rejects(
      control.commit({ ...initial, server: { ...initial.server, maxAttempts: 5 } }, 1, 'admin'),
      /injected before rename/,
    );
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(disk.revision, 1);
    control.reconcileStartup(disk);
    assert.equal((f.store.db.prepare('SELECT state FROM config_journal').get() as { state: string }).state, 'aborted');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('prepared record is aborted when disk still matches its base', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const current = await control.raw();
    f.store.prepareConfigCommit({
      id: 'aborted',
      baseRevision: current.revision,
      baseChecksum: configChecksum(current),
      candidateRevision: current.revision + 1,
      candidateChecksum: 'f'.repeat(64),
      actor: 'admin',
      paths: ['server.maxAttempts'],
      baseConfig: current,
    });
    control.reconcileStartup(current);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM config_journal WHERE id='aborted'").get() as { state: string }).state,
      'aborted',
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('post-rename recovery repairs history and audit idempotently', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService, undefined, {
      afterConfigRename: () => {
        throw new Error('simulated crash');
      },
    });
    const initial = await control.raw();
    await assert.rejects(control.commit({ ...initial, server: { ...initial.server, maxAttempts: 6 } }, 1, 'admin'));
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const recovered = new ControlService(f.configPath, f.store, f.configService);
    recovered.reconcileStartup(disk);
    recovered.reconcileStartup(disk);
    assert.equal(
      (
        f.store.db.prepare('SELECT COUNT(*) AS count FROM config_history WHERE revision IN (1,2)').get() as {
          count: number;
        }
      ).count,
      2,
    );
    assert.equal(
      (
        f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='config.commit'").get() as {
          count: number;
        }
      ).count,
      1,
    );
    assert.equal(
      (f.store.db.prepare('SELECT state FROM config_journal').get() as { state: string }).state,
      'committed',
    );
    const journalText = JSON.stringify(f.store.db.prepare('SELECT * FROM config_journal').all());
    const auditText = JSON.stringify(
      f.store.db.prepare("SELECT detail FROM audit_events WHERE action='config.commit'").all(),
    );
    assert.doesNotMatch(journalText, /config_json|apiKey|secret|keyHash/i);
    assert.doesNotMatch(auditText, /config_json|apiKey|secret|keyHash/i);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('startup recovery removes an orphaned generated secret after a pre-commit crash', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify(legacyConfig()));
    const initialControl = new ControlService(f.configPath, f.store, f.configService);
    const migrated = await initialControl.raw();
    const upstreamId = migrated.upstreams[0]!.id;
    const orphanId = 'sec_123e4567-e89b-42d3-a456-426614174000';
    f.store.secrets.put(orphanId, 'orphan-secret-value');
    const candidate = { ...migrated, revision: migrated.revision + 1 };
    f.store.prepareConfigCommit({
      id: 'simulated-pre-commit-crash',
      baseRevision: migrated.revision,
      baseChecksum: configChecksum(migrated),
      candidateRevision: candidate.revision,
      candidateChecksum: configChecksum(candidate),
      actor: 'admin',
      paths: ['upstreams'],
      baseConfig: migrated,
    });
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    new ControlService(f.configPath, f.store, configService(f.configPath, f.store)).reconcileStartup(disk);
    assert.equal(f.store.secrets.has(orphanId), false);
    const events = f.store.db.prepare("SELECT detail FROM audit_events WHERE action='credential.orphan_gc'").all() as Array<{ detail: string }>;
    assert.deepEqual(events.map(({ detail }) => JSON.parse(detail)), [{ count: 1 }]);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('offline recovery retains secrets referenced by current and historical configs', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify(legacyConfig()));
    const control = new ControlService(f.configPath, f.store, f.configService);
    const migrated = await control.raw();
    const upstreamId = migrated.upstreams[0]!.id;
    const created = await control.credential(upstreamId, 'create', undefined, {
      id: 'retained-credential', label: 'retained', value: 'retained-secret-value',
    }, migrated.revision, 'admin');
    const currentId = created.config.upstreams[0]!.credentials.find((item) => item.id === 'retained-credential')!.secret;
    assert.equal(currentId.type, 'secret');
    const historicalId = migrated.upstreams[0]!.credentials[0]!.secret;
    assert.equal(historicalId.type, 'secret');

    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    new ControlService(f.configPath, f.store, configService(f.configPath, f.store)).reconcileStartup(disk);
    assert.equal(f.store.secrets.has(currentId.id), true);
    assert.equal(f.store.secrets.has(historicalId.id), true);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='credential.orphan_gc'").get() as { count: number }).count, 0);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('orphan collection preserves backup, OAuth, and unknown secret namespaces', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const current = await control.raw();
    const orphanId = 'sec_123e4567-e89b-42d3-a456-426614174000';
    for (const id of [orphanId, 'backup_test', 'legacy_backup_test', 'oauth_test', 'custom_test'])
      f.store.secrets.put(id, `value-${id}`);
    control.reconcileStartup(current);
    assert.equal(f.store.secrets.has(orphanId), false);
    for (const id of ['backup_test', 'legacy_backup_test', 'oauth_test', 'custom_test'])
      assert.equal(f.store.secrets.has(id), true, `${id} should be retained`);
    const event = f.store.db.prepare("SELECT detail FROM audit_events WHERE action='credential.orphan_gc'").get() as { detail: string };
    assert.deepEqual(JSON.parse(event.detail), { count: 1 });
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed history fails closed without deleting generated secrets', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const current = await control.raw();
    const orphanId = 'sec_123e4567-e89b-42d3-a456-426614174000';
    f.store.secrets.put(orphanId, 'keep-on-corrupt-history');
    f.store.db.prepare('INSERT INTO config_history VALUES(?,?,?,?)').run(99, 'test', '{broken', new Date().toISOString());
    assert.throws(() => control.reconcileStartup(current), /malformed config history/);
    assert.equal(f.store.secrets.has(orphanId), true);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='credential.orphan_gc'").get() as { count: number }).count, 0);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('checksum conflict refuses startup recovery without changing JSON', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const base = await control.raw();
    f.store.prepareConfigCommit({
      id: 'conflict',
      baseRevision: 1,
      baseChecksum: configChecksum(base),
      candidateRevision: 2,
      candidateChecksum: 'b'.repeat(64),
      actor: 'admin',
      paths: [],
      baseConfig: base,
    });
    const changed = { ...base, server: { ...base.server, maxAttempts: base.server.maxAttempts + 1 } };
    writeFileSync(f.configPath, JSON.stringify(changed));
    const before = readFileSync(f.configPath, 'utf8');
    assert.throws(() => control.reconcileStartup(changed), /checksum conflict/);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('runtime apply failure is durably degraded', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService, async () => {
      throw new Error('apply unavailable');
    });
    const initial = await control.raw();
    const result = await control.commit({ ...initial, server: { ...initial.server, maxAttempts: 7 } }, 1, 'admin');
    assert.equal(result.effectiveRevision, 1);
    assert.match(result.applyError ?? '', /apply unavailable/);
    const journal = f.store.db.prepare('SELECT state,apply_error FROM config_journal').get() as {
      state: string;
      apply_error: string;
    };
    assert.equal(journal.state, 'degraded');
    assert.match(journal.apply_error, /apply unavailable/);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit_events WHERE action='config.apply_failed'").get());
    assert.equal(f.store.db.prepare("SELECT 1 FROM audit_events WHERE action='config.commit'").get(), undefined);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('concurrent same-revision commits have one CAS winner and owned journal/audit rows', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const initial = await control.raw();
    const outcomes = await Promise.allSettled([
      control.commit({ ...initial, server: { ...initial.server, maxAttempts: 8 } }, 1, 'actor-a'),
      control.commit({ ...initial, server: { ...initial.server, maxAttempts: 9 } }, 1, 'actor-b'),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const rejection = outcomes.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejection.reason), /expected 1/);
    const rows = f.store.db
      .prepare('SELECT id,actor_id,candidate_revision,changed_paths,state FROM config_journal')
      .all() as Array<{
      id: string;
      actor_id: string;
      candidate_revision: number;
      changed_paths: string;
      state: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.candidate_revision, 2);
    assert.equal(rows[0]?.state, 'committed');
    const audit = f.store.db
      .prepare("SELECT id,actor_id,detail FROM audit_events WHERE action='config.commit'")
      .get() as {
      id: string;
      actor_id: string;
      detail: string;
    };
    assert.equal(audit.id, rows[0]?.id);
    assert.equal(audit.actor_id, rows[0]?.actor_id);
    const detail = JSON.parse(audit.detail) as { paths: string[]; journalId: string };
    assert.equal(detail.journalId, rows[0]?.id);
    assert.deepEqual(detail.paths, JSON.parse(rows[0]!.changed_paths));
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('startup finalizes degraded candidate after successful runtime snapshot build', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService, async () => {
      throw new Error('first apply failed');
    });
    const initial = await control.raw();
    await control.commit({ ...initial, server: { ...initial.server, maxAttempts: 10 } }, 1, 'admin');
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const recovery = new ControlService(f.configPath, f.store, f.configService);
    recovery.reconcileStartup(disk);
    const journal = f.store.db.prepare('SELECT state,apply_error FROM config_journal').get() as {
      state: string;
      apply_error: string | null;
    };
    assert.equal(journal.state, 'committed');
    assert.equal(journal.apply_error, null);
    assert.equal(
      (
        f.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='config.commit'").get() as {
          count: number;
        }
      ).count,
      1,
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('external edit observation writes a committed journal and audit after reconciliation', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const before = await control.raw();
    const after = { ...before, revision: before.revision + 1, server: { ...before.server, maxAttempts: 11 } };
    control.recordObservedExternal(before, after, undefined, 'applied');
    const row = f.store.db.prepare('SELECT actor_id,state,changed_paths FROM config_journal').get() as {
      actor_id: string;
      state: string;
      changed_paths: string;
    };
    assert.equal(row.actor_id, 'external');
    assert.equal(row.state, 'committed');
    assert.ok((JSON.parse(row.changed_paths) as string[]).includes('server.maxAttempts'));
    const audit = f.store.db.prepare("SELECT detail FROM audit_events WHERE action='config.commit'").get() as {
      detail: string;
    };
    assert.equal((JSON.parse(audit.detail) as { source: string }).source, 'observed_external');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('external observation finalizes durable metadata before the runtime swap and retries idempotently', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const before = await control.raw();
    const after = { ...before, revision: before.revision + 1, server: { ...before.server, maxAttempts: 12 } };
    let observedJournal = false;
    const failSwap = () => {
      observedJournal = Boolean(f.store.db.prepare("SELECT 1 FROM config_journal WHERE actor_id='external'").get());
      throw new Error('swap seam');
    };
    assert.throws(() => control.recordObservedExternal(before, after, failSwap), /swap seam/);
    assert.equal(observedJournal, true);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM config_journal WHERE actor_id='external'").get() as { state: string })
        .state,
      'committed',
    );
    let swaps = 0;
    control.recordObservedExternal(
      before,
      after,
      () => {
        swaps++;
      },
      'applied',
    );
    assert.equal(swaps, 1);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM config_journal WHERE actor_id='external'").get() as { state: string })
        .state,
      'committed',
    );
    assert.equal(
      (
        f.store.db.prepare("SELECT COUNT(*) AS count FROM config_journal WHERE actor_id='external'").get() as {
          count: number;
        }
      ).count,
      1,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='config.commit' AND actor_id='external'")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('external journal or history failure prevents runtime swap', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const before = await control.raw();
    const after = { ...before, revision: before.revision + 1, server: { ...before.server, maxAttempts: 20 } };
    f.store.history(after.revision, 'conflicting-writer', { revision: after.revision, different: true });
    let swapped = false;
    assert.throws(
      () =>
        control.recordObservedExternal(before, after, () => {
          swapped = true;
        }),
      /Conflicting config history/,
    );
    assert.equal(swapped, false);
    assert.equal(
      (
        f.store.db.prepare("SELECT COUNT(*) AS count FROM config_journal WHERE actor_id='external'").get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('startup recovers an external prepared record after a crash before finalization', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const before = await control.raw();
    const candidate = { ...before, revision: before.revision + 1, server: { ...before.server, maxAttempts: 21 } };
    f.store.prepareObservedExternal({
      baseRevision: before.revision,
      baseChecksum: configChecksum(before),
      candidateRevision: candidate.revision,
      candidateChecksum: configChecksum(candidate),
      paths: ['server.maxAttempts'],
      baseConfig: before,
      candidateConfig: candidate,
    });
    assert.equal(
      (f.store.db.prepare("SELECT state FROM config_journal WHERE actor_id='external'").get() as { state: string })
        .state,
      'prepared',
    );
    control.reconcileStartup(candidate);
    const row = f.store.db.prepare("SELECT state FROM config_journal WHERE actor_id='external'").get() as {
      state: string;
    };
    const audit = f.store.db
      .prepare("SELECT detail FROM audit_events WHERE action='config.commit' AND actor_id='external'")
      .get() as { detail: string };
    assert.equal(row.state, 'committed');
    assert.equal((JSON.parse(audit.detail) as { runtimeState: string }).runtimeState, 'recovered');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('external content change without revision advance is rejected before runtime swap', async () => {
  const f = fixture();
  try {
    const control = new ControlService(f.configPath, f.store, f.configService);
    const before = await control.raw();
    const changedSameRevision = { ...before, server: { ...before.server, maxAttempts: 13 } };
    let swapped = false;
    assert.throws(
      () =>
        control.recordObservedExternal(before, changedSameRevision, () => {
          swapped = true;
        }),
      /advance exactly one revision/,
    );
    const jumped = { ...before, revision: before.revision + 2, server: { ...before.server, maxAttempts: 13 } };
    assert.throws(
      () =>
        control.recordObservedExternal(before, jumped, () => {
          swapped = true;
        }),
      /advance exactly one revision/,
    );
    assert.equal(swapped, false);
    assert.equal(
      (f.store.db.prepare('SELECT COUNT(*) AS count FROM config_journal').get() as { count: number }).count,
      0,
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('degraded commit is resolved only through a complete later committed checksum chain', async () => {
  const f = fixture();
  try {
    let applyCalls = 0;
    const control = new ControlService(f.configPath, f.store, f.configService, async (next) => {
      applyCalls++;
      if (applyCalls === 1) throw new Error('temporary runtime failure');
      return next.revision;
    });
    const initial = await control.raw();
    await control.commit({ ...initial, server: { ...initial.server, maxAttempts: 14 } }, 1, 'admin');
    const second = await control.raw();
    await control.commit({ ...second, server: { ...second.server, maxAttempts: 15 } }, 2, 'admin');
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const recovery = new ControlService(f.configPath, f.store, f.configService);
    recovery.reconcileStartup(disk);
    const degraded = f.store.db
      .prepare('SELECT state,resolution_status,superseded_by_revision FROM config_journal WHERE candidate_revision=2')
      .get() as {
      state: string;
      resolution_status: string;
      superseded_by_revision: number;
    };
    assert.equal(degraded.state, 'degraded');
    assert.equal(degraded.resolution_status, 'superseded');
    assert.equal(degraded.superseded_by_revision, 3);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit_events WHERE action='config.superseded'").get());
    assert.ok(
      f.store.db
        .prepare("SELECT 1 FROM audit_events WHERE action='config.commit' AND json_extract(detail,'$.revision')=2")
        .get(),
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('degraded row with a revision gap remains fail-closed', async () => {
  const f = fixture();
  try {
    let fail = true;
    const control = new ControlService(f.configPath, f.store, f.configService, async (next) => {
      if (fail) {
        fail = false;
        throw new Error('apply failed');
      }
      return next.revision;
    });
    const initial = await control.raw();
    await control.commit({ ...initial, server: { ...initial.server, maxAttempts: 16 } }, 1, 'admin');
    const next = await control.raw();
    await control.commit({ ...next, server: { ...next.server, maxAttempts: 17 } }, 2, 'admin');
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const changed = { ...disk, revision: disk.revision + 1 };
    // Create an unjournaled disk head. It has no valid committed edge from revision 2.
    writeFileSync(f.configPath, JSON.stringify(changed));
    assert.throws(
      () => new ControlService(f.configPath, f.store, f.configService).reconcileStartup(changed),
      /checksum conflict/,
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('offline commit reconciles unresolved prepared journal before creating a new commit', async () => {
  const f = fixture();
  try {
    const crashed = new ControlService(f.configPath, f.store, f.configService, undefined, {
      afterConfigRename: () => {
        throw new Error('simulated process interruption');
      },
    });
    const initial = await crashed.raw();
    await assert.rejects(crashed.commit({ ...initial, server: { ...initial.server, maxAttempts: 18 } }, 1, 'cli'));
    const next = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const offline = new ControlService(f.configPath, f.store, f.configService);
    await offline.commit({ ...next, server: { ...next.server, maxAttempts: 19 } }, 2, 'cli');
    const rows = f.store.db
      .prepare('SELECT candidate_revision,state FROM config_journal ORDER BY candidate_revision')
      .all() as Array<{ candidate_revision: number; state: string }>;
    assert.deepEqual(rows, [
      { candidate_revision: 2, state: 'committed' },
      { candidate_revision: 3, state: 'committed' },
    ]);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
