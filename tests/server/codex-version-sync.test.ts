import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCanonicalIdentity,
  CODEX_MIN_VERSION,
  readSyncedCodexVersion,
  resetSyncedCodexVersionForTests,
  updateSyncedCodexVersion,
} from '../../src/saas/gateway/codex/identity.js';
import {
  CODEX_VERSION_SYNC_LATEST_RELEASES_URL,
  CODEX_VERSION_SYNC_RELEASES_LIST_URL,
  fetchLatestCodexStableVersion,
  parseCodexReleaseEntry,
  parseCodexReleaseTagName,
} from '../../src/saas/supply/codex-version-sync.js';
import { startCodexVersionSyncWorker } from '../../src/server/codex-version-sync.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFoundResponse(): Response {
  return jsonResponse({ message: 'Not Found' }, 404);
}

const RELEASE_0_150 = { tag_name: 'rust-v0.150.0', prerelease: false, draft: false } as const;

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

/** Sets env keys for the duration of one callback, restoring the prior state after. */
async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Release-feed surface (the pure module the classic worker shares with the
// SaaS plane) — exercised through the injected fetch seam, no network.
// ---------------------------------------------------------------------------

test('parseCodexReleaseTagName extracts only stable rust-vX.Y.Z tags', () => {
  assert.equal(parseCodexReleaseTagName('rust-v0.150.0'), '0.150.0');
  assert.equal(parseCodexReleaseTagName('  rust-v1.2.3  '), '1.2.3');
  // Prerelease suffixes, non-rust-v tags and non-strings: rejected.
  assert.equal(parseCodexReleaseTagName('rust-v0.150.0-beta.1'), null);
  assert.equal(parseCodexReleaseTagName('v0.150.0'), null);
  assert.equal(parseCodexReleaseTagName('codex-v0.150.0'), null);
  assert.equal(parseCodexReleaseTagName(null), null);
});

test('parseCodexReleaseEntry rejects prerelease and draft release flags', () => {
  assert.equal(parseCodexReleaseEntry(RELEASE_0_150), '0.150.0');
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, prerelease: true }), null);
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, draft: true }), null);
  assert.equal(parseCodexReleaseEntry({ ...RELEASE_0_150, tag_name: 'rust-v0.150.0-rc.1' }), null);
  assert.equal(parseCodexReleaseEntry(null), null);
  assert.equal(parseCodexReleaseEntry({}), null);
});

test('fetchLatestCodexStableVersion reads the /releases/latest document', async () => {
  const urls: string[] = [];
  const version = await fetchLatestCodexStableVersion((url) => {
    urls.push(url);
    return Promise.resolve(jsonResponse(RELEASE_0_150));
  });
  assert.equal(version, '0.150.0');
  assert.deepEqual(urls, [CODEX_VERSION_SYNC_LATEST_RELEASES_URL]);
});

test('fetchLatestCodexStableVersion falls back to the release list on 404', async () => {
  const urls: string[] = [];
  const version = await fetchLatestCodexStableVersion((url) => {
    urls.push(url);
    if (url === CODEX_VERSION_SYNC_LATEST_RELEASES_URL) return Promise.resolve(notFoundResponse());
    return Promise.resolve(
      jsonResponse([
        { tag_name: 'rust-v0.151.0-beta.1', prerelease: false, draft: false },
        { tag_name: 'rust-v0.151.0', prerelease: true, draft: false },
        { tag_name: 'v0.151.0', prerelease: false, draft: false },
        RELEASE_0_150,
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

// ---------------------------------------------------------------------------
// Classic worker
// ---------------------------------------------------------------------------

test('runOnce updates the process-level synced slot on a newer stable release', async () => {
  resetSyncedCodexVersionForTests();
  // The start() immediate round must fail so the MANUAL runOnce below is
  // the writer — otherwise forward-only correctly no-ops the second write.
  let releaseFeed: 'unavailable' | 'ok' = 'unavailable';
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => Promise.resolve(releaseFeed === 'ok' ? jsonResponse(RELEASE_0_150) : notFoundResponse()),
  });
  try {
    assert.equal(readSyncedCodexVersion(), null);
    assert.equal(await handle.runOnce(), false);
    assert.equal(readSyncedCodexVersion(), null);
    releaseFeed = 'ok';
    assert.equal(await handle.runOnce(), true);
    assert.equal(readSyncedCodexVersion(), '0.150.0');
    // Same release again: forward-only, no write.
    assert.equal(await handle.runOnce(), false);
    assert.equal(readSyncedCodexVersion(), '0.150.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('the started loop performs one immediate round and updates the slot', async () => {
  resetSyncedCodexVersionForTests();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker({
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
    assert.equal(readSyncedCodexVersion(), '0.150.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('an older release never downgrades the synced slot', async () => {
  resetSyncedCodexVersionForTests();
  assert.equal(updateSyncedCodexVersion('0.152.0'), true);
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => Promise.resolve(jsonResponse(RELEASE_0_150)),
  });
  try {
    assert.equal(await handle.runOnce(), false);
    assert.equal(readSyncedCodexVersion(), '0.152.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('a release below the upstream minimum is never written', async () => {
  resetSyncedCodexVersionForTests();
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => Promise.resolve(jsonResponse({ tag_name: 'rust-v0.100.0', prerelease: false, draft: false })),
  });
  try {
    assert.equal(await handle.runOnce(), false);
    assert.equal(readSyncedCodexVersion(), null);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('a failed feed round resolves false without writing the slot', async () => {
  resetSyncedCodexVersionForTests();
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => Promise.resolve(notFoundResponse()),
  });
  try {
    assert.equal(await handle.runOnce(), false);
    assert.equal(readSyncedCodexVersion(), null);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('the manual env pin suppresses writes at or below the pin', async () => {
  resetSyncedCodexVersionForTests();
  await withEnv({ MODEL_ROUTER_CODEX_CLIENT_VERSION: '0.160.0' }, async () => {
    const handle = startCodexVersionSyncWorker({
      fetchImpl: () => Promise.resolve(jsonResponse(RELEASE_0_150)),
    });
    try {
      // 0.150.0 is at/below the pin: no write.
      assert.equal(await handle.runOnce(), false);
      assert.equal(readSyncedCodexVersion(), null);
    } finally {
      await handle.close();
    }
    const handleAbovePin = startCodexVersionSyncWorker({
      fetchImpl: () => Promise.resolve(jsonResponse({ tag_name: 'rust-v0.161.0', prerelease: false, draft: false })),
    });
    try {
      // Above the pin: runOnce JOINS the start round (singleflight) and the
      // slot ratchets (the pin still wins at identity resolution time).
      assert.equal(await handleAbovePin.runOnce(), true);
      assert.equal(readSyncedCodexVersion(), '0.161.0');
    } finally {
      await handleAbovePin.close();
    }
  });
  resetSyncedCodexVersionForTests();
});

test('an ineligible env pin is ignored and does not gate the sync', async () => {
  resetSyncedCodexVersionForTests();
  await withEnv({ MODEL_ROUTER_CODEX_CLIENT_VERSION: 'not-a-version' }, async () => {
    const handle = startCodexVersionSyncWorker({
      fetchImpl: () => Promise.resolve(jsonResponse(RELEASE_0_150)),
    });
    try {
      // runOnce joins the start round (singleflight): the ignored pin never
      // gated the write.
      assert.equal(await handle.runOnce(), true);
      assert.equal(readSyncedCodexVersion(), '0.150.0');
    } finally {
      await handle.close();
    }
  });
  resetSyncedCodexVersionForTests();
});

test('enabled: false performs no fetches', async () => {
  resetSyncedCodexVersionForTests();
  let fetchCount = 0;
  const handle = startCodexVersionSyncWorker({
    enabled: false,
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
  });
  try {
    await settle(150);
    assert.equal(fetchCount, 0);
    assert.equal(await handle.runOnce(), false);
    assert.equal(fetchCount, 0);
    assert.equal(readSyncedCodexVersion(), null);
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('MODEL_ROUTER_CODEX_VERSION_SYNC=off performs no fetches', async () => {
  resetSyncedCodexVersionForTests();
  await withEnv({ MODEL_ROUTER_CODEX_VERSION_SYNC: 'off' }, async () => {
    let fetchCount = 0;
    const handle = startCodexVersionSyncWorker({
      fetchImpl: () => {
        fetchCount += 1;
        return Promise.resolve(jsonResponse(RELEASE_0_150));
      },
    });
    try {
      await settle(150);
      assert.equal(fetchCount, 0);
      assert.equal(await handle.runOnce(), false);
      assert.equal(fetchCount, 0);
      assert.equal(readSyncedCodexVersion(), null);
    } finally {
      await handle.close();
    }
  });
  resetSyncedCodexVersionForTests();
});

test('the interval is honored through the injected clock', async () => {
  resetSyncedCodexVersionForTests();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker({
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
    // Advancing virtual time past the interval triggers the next round.
    clock.advance(60_000);
    await until(() => fetchCount >= 2);
    assert.equal(fetchCount, 2);
    assert.equal(readSyncedCodexVersion(), '0.150.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});

test('close() is idempotent and stops the loop', async () => {
  resetSyncedCodexVersionForTests();
  let fetchCount = 0;
  const clock = createManualClock();
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => {
      fetchCount += 1;
      return Promise.resolve(jsonResponse(RELEASE_0_150));
    },
    nowMs: clock.now,
    intervalMs: 60_000,
  });
  await until(() => fetchCount >= 1);
  await handle.close();
  await handle.close();
  clock.advance(120_000);
  await settle(150);
  assert.equal(fetchCount, 1);
  // A post-close manual round is a no-op.
  assert.equal(await handle.runOnce(), false);
  assert.equal(fetchCount, 1);
  resetSyncedCodexVersionForTests();
});

test('the synced slot feeds buildCanonicalIdentity once written by the worker', async () => {
  resetSyncedCodexVersionForTests();
  const handle = startCodexVersionSyncWorker({
    fetchImpl: () => Promise.resolve(jsonResponse({ tag_name: 'rust-v0.170.0', prerelease: false, draft: false })),
  });
  try {
    // runOnce joins the start round (singleflight): the write is visible.
    assert.equal(await handle.runOnce(), true);
    const identity = buildCanonicalIdentity();
    assert.equal(identity.version, '0.170.0');
    // The manual override still wins over the synced slot.
    const pinned = buildCanonicalIdentity('0.158.0');
    assert.equal(pinned.version, '0.158.0');
    // Baseline eligibility sanity for the constants the guard relies on.
    assert.equal(CODEX_MIN_VERSION, '0.144.0');
  } finally {
    await handle.close();
    resetSyncedCodexVersionForTests();
  }
});
