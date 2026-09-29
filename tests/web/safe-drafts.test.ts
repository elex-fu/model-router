import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearSafeDraft, hasSafeDraft, latestSafeDraftId, readSafeDraft, saveSafeDraft } from '../../web/src/app/safe-drafts.ts';

const storageKey = 'model-router:safe-drafts:v1';
function withSessionStorage(run: (storage: Storage) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage } });
  try { run(storage); }
  finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('safe drafts follow tab storage lifecycle and clear by scope or logout', () => withSessionStorage(storage => {
  assert.equal(saveSafeDraft('upstream', 'new', { name: 'Local Ollama', protocol: 'openai' }), true);
  assert.equal(hasSafeDraft('upstream', 'new'), true);
  assert.deepEqual(readSafeDraft('upstream', 'new'), { name: 'Local Ollama', protocol: 'openai' });
  assert.equal(storage.getItem(storageKey)?.includes('Local Ollama'), true);
  clearSafeDraft('upstream', 'new');
  assert.equal(hasSafeDraft('upstream', 'new'), false);
  saveSafeDraft('route', 'route-id', { name: 'local route' });
  assert.equal(latestSafeDraftId('route'), 'route-id');
  clearSafeDraft();
  assert.equal(storage.getItem(storageKey), null);
}));

test('only explicitly allowlisted fields persist and sensitive keys or values are rejected', () => withSessionStorage(storage => {
  assert.equal(saveSafeDraft('key', 'new', { name: 'team', description: 'internal', password: 'do-not-save' }), false);
  assert.equal(storage.getItem(storageKey), null);
  assert.equal(saveSafeDraft('key', 'new', { name: 'sk-live-abcdefghijk' }), false);
  assert.equal(storage.getItem(storageKey), null);
  assert.equal(saveSafeDraft('route', 'new', { name: 'route', unlisted: 'ignored' }), true);
  assert.deepEqual(readSafeDraft('route', 'new'), { name: 'route' });
}));

test('expired drafts are removed and never restored', () => withSessionStorage(storage => {
  const now = Date.now();
  storage.setItem(storageKey, JSON.stringify({ upstream: { new: { savedAt: now - 31 * 60 * 1000, values: { name: 'stale' } } } }));
  assert.equal(readSafeDraft('upstream', 'new'), undefined);
  assert.equal(latestSafeDraftId('upstream'), undefined);
}));
