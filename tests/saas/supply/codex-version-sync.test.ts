import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCanonicalIdentity,
  CODEX_BASELINE_VERSION,
  readSyncedCodexVersion,
  resetSyncedCodexVersionForTests,
  updateSyncedCodexVersion,
} from '../../../src/saas/gateway/codex/identity.js';
import {
  CODEX_CLIENT_VERSION_SETTINGS_KEY,
  CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY,
  CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY,
  getPlatformSettingDefinition,
  parseCodexClientVersionSetting,
  parseCodexVersionAutoSyncEnabledSetting,
} from '../../../src/saas/platform/settings/registry.js';
import {
  CODEX_VERSION_SYNC_LATEST_RELEASES_URL,
  CODEX_VERSION_SYNC_RELEASES_LIST_URL,
  CODEX_VERSION_SYNC_WORKER_LABEL,
  type CodexVersionSyncSettings,
  CodexVersionSyncWorker,
  codexReleaseTagFor,
  fetchLatestCodexStableVersion,
  parseCodexReleaseEntry,
  seedSyncedCodexVersionFromSettings,
  startCodexVersionSyncWorker,
} from '../../../src/saas/supply/codex-version-sync.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFoundResponse(): Response {
  return jsonResponse({ message: 'Not Found' }, 404);
}

/** Records every put and serves the current values from an in-memory map. */
class SettingsStub implements CodexVersionSyncSettings {
  private readonly recordedPuts: { key: string; value: string; actor: string; entryPoint: string }[] = [];
  private readonly values = new Map<string, unknown>();

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get puts(): ReadonlyArray<{ key: string; value: string; actor: string; entryPoint: string }> {
    return this.recordedPuts;
  }

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: string, context: Readonly<{ actor: string; entryPoint: string }>): Promise<void> {
    this.recordedPuts.push({ key, value, actor: context.actor, entryPoint: context.entryPoint });
    this.values.set(key, value);
  }

  putCount(): number {
    return this.recordedPuts.length;
  }
}

interface ManualClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

function createManualClock(startMs = 1_000_000): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('condition not met within the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settle(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const RELEASE_0_150 = { tag_name: 'rust-v0.150.0', prerelease: false, draft: false } as const;

test('codexReleaseTagFor is the inverse of the release tag grammar', () => {
  assert.equal(codexReleaseTagFor('0.150.0'), 'rust-v0.150.0');
});

test('parseCodexReleaseEntry accepts only stable rust-v release tags', () => {
  assert.equal(parseCodexReleaseEntry(RELEASE_0_150), '0.150.0');
  // Prerelease suffix in the tag: rejected.
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, tag_name: 'rust-v0.150.0-beta.1' }), null);
  // Non-rust-v tags: rejected.
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, tag_name: 'v0.150.0' }), null);
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, tag_name: 'codex-v0.150.0' }), null);
  // Release-level prerelease/draft flags: rejected.
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, prerelease: true }), null);
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, draft: true }), null);
  // Malformed shapes: rejected.
  assert.equal(parseCodexReleaseEntry(null), null);
  assert.equal(parseCodexReleaseEntry('rust-v0.150.0'), null);
  assert.equal(parseCodexReleaseEntry({}), null);
});

test('fetchLatestCodexStableVersion reads the /releases/latest document', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const version = await fetchLatestCodexStableVersion((url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return Promise.resolve(jsonResponse(RELEASE_0_150));
  });
  assert.equal(version, '0.150.0');
  assert.deepEqual(
    calls.map((call) => call.url),
    [CODEX_VERSION_SYNC_LATEST_RELEASES_URL],
  );
  assert.equal(calls[0].headers.accept, 'application/vnd.github+json');
});

test('fetchLatestCodexStableVersion falls back to the release list on 404', async () => {
  const urls: string[] = [];
  const version = await fetchLatestCodexStableVersion((url) => {
    urls.push(url);
    if (url === CODEX_VERSION_SYNC_LATEST_RELEASES_URL) return Promise.resolve(notFoundResponse());
    return Promise.resolve(
      jsonResponse([
        { tag_name: 'rust-v0.151.0-beta.1', prerelease: false, draft: false },
        { tag_name: 'v0.151.0', prerelease: false, draft: false },
        { tag_name: 'rust-v0.151.0', prerelease: true, draft: false },
        { tag_name: 'rust-v0.150.0', prerelease: false, draft: false },
      ]),
    );
  });
  assert.equal(version, '0.150.0');
  assert.deepEqual(urls, [CODEX_VERSION_SYNC_LATEST_RELEASES_URL, CODEX_VERSION_SYNC_RELEASES_LIST_URL]);
});

test('fetchLatestCodexStableVersion returns null when both endpoints fail', async () => {
  const urls: string[] = [];
  const version = await fetchLatestCodexStableVersion((url) => {
    urls.push(url);
    return Promise.resolve(notFoundResponse());
  });
  assert.equal(version, null);
  assert.deepEqual(urls, [CODEX_VERSION_SYNC_LATEST_RELEASES_URL, CODEX_VERSION_SYNC_RELEASES_LIST_URL]);
});

test('fetchLatestCodexStableVersion returns null on non-matching tags, malformed bodies and network errors', async () => {
  assert.equal(
    await fetchLatestCodexStableVersion(() => Promise.resolve(jsonResponse({ tag_name: 'v0.150.0' }))),
    null,
  );
  assert.equal(await fetchLatestCodexStableVersion(() => Promise.resolve(jsonResponse({}))), null);
  assert.equal(
    await fetchLatestCodexStableVersion(() => Promise.resolve(new Response('<html>not json', { status: 200 }))),
    null,
  );
  assert.equal(
    await fetchLatestCodexStableVersion(() => Promise.resolve(jsonResponse({ message: 'rate limited' }, 403))),
    null,
  );
  assert.equal(await fetchLatestCodexStableVersion(() => Promise.reject(new Error('network down'))), null);
});

test('the version sync worker writes a newer stable release once and seeds the identity slot', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker(settings, {
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
    nowMs: clock.now,
    intervalMs: 60_000,
  });
  try {
    await until(() => fetchCount >= 1);
    await settle(50);
    assert.equal(fetchCount, 1);
    assert.deepEqual(settings.puts, [
      {
        key: CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY,
        value: '0.150.0',
        actor: CODEX_VERSION_SYNC_WORKER_LABEL,
        entryPoint: CODEX_VERSION_SYNC_WORKER_LABEL,
      },
    ]);
    assert.equal(readSyncedCodexVersion(), '0.150.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('the version sync worker never rewrites an unchanged release (forward-only)', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub({
    [CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY]: '0.150.0',
  });
  let fetchCount = 0;
  const handle = startCodexVersionSyncWorker(settings, {
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
  });
  try {
    await until(() => fetchCount >= 1);
    await settle(100);
    assert.equal(fetchCount, 1);
    assert.equal(settings.putCount(), 0);
    assert.equal(readSyncedCodexVersion(), null);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('sync rounds are forward-only against max(synced, override)', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub({
    [CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY]: '0.150.0',
    [CODEX_CLIENT_VERSION_SETTINGS_KEY]: '0.160.0',
  });
  let release = 'rust-v0.149.0';
  const worker = new CodexVersionSyncWorker(settings, {
    fetchImpl: () => Promise.resolve(jsonResponse({ ...RELEASE_0_150, tag_name: release })),
  });
  try {
    // Older than the stored synced value: unchanged, no write.
    assert.deepEqual(await worker.runOnce(), { state: 'unchanged', version: '0.149.0' });
    // Newer than the stored synced value but below the admin override: still no write.
    release = 'rust-v0.155.0';
    assert.deepEqual(await worker.runOnce(), { state: 'unchanged', version: '0.155.0' });
    assert.equal(settings.putCount(), 0);
    assert.equal(readSyncedCodexVersion(), null);
    // Above the override: the synced key is written and the identity slot seeded.
    release = 'rust-v0.161.0';
    assert.deepEqual(await worker.runOnce(), { state: 'synced', version: '0.161.0', previousVersion: '0.150.0' });
    assert.equal(settings.putCount(), 1);
    assert.equal(await settings.get(CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY), '0.161.0');
    assert.equal(readSyncedCodexVersion(), '0.161.0');
  } finally {
    await worker.close();
    resetSyncedCodexVersionForTests();
  }
});

test('a sync round with no usable release reports unavailable without writing', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub();
  const worker = new CodexVersionSyncWorker(settings, {
    fetchImpl: () => Promise.resolve(notFoundResponse()),
  });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'unavailable' });
    assert.equal(settings.putCount(), 0);
  } finally {
    await worker.close();
    resetSyncedCodexVersionForTests();
  }
});

test('the version sync interval is honored against the injected clock', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker(settings, {
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
    nowMs: clock.now,
    intervalMs: 60_000,
  });
  try {
    // Immediate first run.
    await until(() => fetchCount >= 1);
    assert.equal(settings.putCount(), 1);
    // Before the interval elapses there is no second fetch.
    clock.advance(59_000);
    await settle(150);
    assert.equal(fetchCount, 1);
    // Across the interval the second cycle runs; the unchanged release
    // (now stored by the stub) is not written a second time.
    clock.advance(2_000);
    await until(() => fetchCount >= 2);
    assert.equal(settings.putCount(), 1);
    clock.advance(60_000);
    await until(() => fetchCount >= 3);
    assert.equal(settings.putCount(), 1);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test("the 'false' auto-sync settings flag skips fetching and writing", async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub({
    [CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY]: 'false',
  });
  let fetchCount = 0;
  const handle = startCodexVersionSyncWorker(settings, {
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
  });
  try {
    await settle(150);
    assert.equal(fetchCount, 0);
    assert.equal(settings.putCount(), 0);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('a boolean false auto-sync flag and the static enabled option also skip cycles', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub({
    [CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY]: false,
  });
  let fetchCount = 0;
  const fetchImpl = () => {
    fetchCount += 1;
    return Promise.resolve(jsonResponse(RELEASE_0_150));
  };
  const handle = startCodexVersionSyncWorker(settings, { fetchImpl });
  const disabledHandle = startCodexVersionSyncWorker(new SettingsStub(), {
    fetchImpl,
    enabled: false,
  });
  try {
    await settle(150);
    assert.equal(fetchCount, 0);
    assert.equal(settings.putCount(), 0);
  } finally {
    await Promise.all([handle.close(), disabledHandle.close()]);
    resetSyncedCodexVersionForTests();
  }
});

test('close() stops the sync loop', async () => {
  resetSyncedCodexVersionForTests();
  const settings = new SettingsStub();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker(settings, {
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
    nowMs: clock.now,
    intervalMs: 60_000,
  });
  await until(() => fetchCount >= 1);
  await handle.close();
  clock.advance(600_000);
  await settle(200);
  assert.equal(fetchCount, 1);
  resetSyncedCodexVersionForTests();
});

test('seedSyncedCodexVersionFromSettings seeds max(synced, override) into the identity slot', async () => {
  resetSyncedCodexVersionForTests();
  try {
    assert.equal(await seedSyncedCodexVersionFromSettings(new SettingsStub()), null);
    assert.equal(readSyncedCodexVersion(), null);

    const syncedOnly = new SettingsStub({
      [CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY]: '0.150.0',
    });
    assert.equal(await seedSyncedCodexVersionFromSettings(syncedOnly), '0.150.0');
    assert.equal(readSyncedCodexVersion(), '0.150.0');

    const withOverride = new SettingsStub({
      [CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY]: '0.150.0',
      [CODEX_CLIENT_VERSION_SETTINGS_KEY]: '0.160.0',
    });
    assert.equal(await seedSyncedCodexVersionFromSettings(withOverride), '0.160.0');
    assert.equal(readSyncedCodexVersion(), '0.160.0');

    // Ineligible values (below the minimum, malformed, empty) never seed.
    const ineligible = new SettingsStub({
      [CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY]: '0.100.0',
      [CODEX_CLIENT_VERSION_SETTINGS_KEY]: 'garbage',
    });
    assert.equal(await seedSyncedCodexVersionFromSettings(ineligible), '0.160.0');
  } finally {
    resetSyncedCodexVersionForTests();
  }
});

test('identity integration: a synced slot is advertised until it is ineligible', () => {
  resetSyncedCodexVersionForTests();
  try {
    assert.equal(updateSyncedCodexVersion('0.150.0'), true);
    assert.equal(buildCanonicalIdentity().version, '0.150.0');
    assert.match(buildCanonicalIdentity().userAgent, /^codex_cli_rs\/0\.150\.0 /);
  } finally {
    resetSyncedCodexVersionForTests();
  }
  // Below the minimum the synced value is ignored, so the baseline stands.
  assert.equal(updateSyncedCodexVersion('0.100.0'), false);
  assert.equal(readSyncedCodexVersion(), null);
  assert.equal(buildCanonicalIdentity().version, CODEX_BASELINE_VERSION);
});

test('the codex version settings keys are registered plain definitions with strict grammars', () => {
  const versionDefinition = getPlatformSettingDefinition(CODEX_CLIENT_VERSION_SETTINGS_KEY);
  const syncedDefinition = getPlatformSettingDefinition(CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY);
  const enabledDefinition = getPlatformSettingDefinition(CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY);
  assert.ok(versionDefinition && syncedDefinition && enabledDefinition);
  assert.equal(versionDefinition.kind, 'plain');
  assert.equal(syncedDefinition.kind, 'plain');
  assert.equal(enabledDefinition.kind, 'plain');
  // Plain keys carry no consumer allowlist (the registration/plaza/brand precedent).
  assert.equal(versionDefinition.consumers, undefined);
  assert.equal(syncedDefinition.consumers, undefined);
  assert.equal(enabledDefinition.consumers, undefined);
  // The registry definitions parse through the same strict grammar.
  assert.equal(versionDefinition.parse(' 0.150.0 '), '0.150.0');
  assert.equal(syncedDefinition.parse('0.149.1'), '0.149.1');
  assert.equal(enabledDefinition.parse('false'), false);

  // Version grammar: trim, empty allowed, bare semver only.
  assert.equal(parseCodexClientVersionSetting(' 0.150.0 '), '0.150.0');
  assert.equal(parseCodexClientVersionSetting('   '), '');
  assert.throws(() => parseCodexClientVersionSetting('0.150.0-beta.1'));
  assert.throws(() => parseCodexClientVersionSetting('rust-v0.150.0'));
  assert.throws(() => parseCodexClientVersionSetting('v0.150.0'));
  assert.throws(() => parseCodexClientVersionSetting('0.150'));
  assert.throws(() => parseCodexClientVersionSetting(12));
  assert.throws(() => parseCodexClientVersionSetting(null));

  // Auto-sync switch grammar: "true"/"false" strings, booleans pass through.
  assert.equal(parseCodexVersionAutoSyncEnabledSetting('true'), true);
  assert.equal(parseCodexVersionAutoSyncEnabledSetting('false'), false);
  assert.equal(parseCodexVersionAutoSyncEnabledSetting(true), true);
  assert.equal(parseCodexVersionAutoSyncEnabledSetting(false), false);
  assert.throws(() => parseCodexVersionAutoSyncEnabledSetting('yes'));
  assert.throws(() => parseCodexVersionAutoSyncEnabledSetting(''));
  assert.throws(() => parseCodexVersionAutoSyncEnabledSetting(1));
  assert.throws(() => parseCodexVersionAutoSyncEnabledSetting(null));
});
