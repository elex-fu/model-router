import assert from 'node:assert/strict';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlStore } from '../../src/control/store.js';
import { loadOrCreateMasterKey } from '../../src/secrets/store.js';

test('secret encryption and persistent key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-secrets-'));
  try {
    const store = new ControlStore(dir);
    store.secrets.put('upstream-1', 'secret-value-123');
    assert.equal(store.secrets.get('upstream-1'), 'secret-value-123');
    assert.equal(readFileSync(join(dir, 'control.sqlite')).includes(Buffer.from('secret-value-123')), false);
    store.close();
    const reopened = new ControlStore(dir);
    assert.equal(reopened.secrets.get('upstream-1'), 'secret-value-123');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('master key creation syncs contents before publishing and syncs the directory before use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-master-key-'));
  const keyPath = join(dir, 'master.key');
  const events: string[] = [];
  const descriptors = new Map<number, string>();
  let serial = 0;
  const key = Buffer.alloc(32, 7);
  try {
    const result = loadOrCreateMasterKey(keyPath, {
      mkdir: (path, options) => { events.push('mkdir'); mkdirSync(path, options); },
      open: (path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        descriptors.set(fd, path);
        events.push(path === dir ? 'open-directory' : path === keyPath ? 'open-key' : 'open-temp');
        return fd;
      },
      write: (fd, data) => { events.push('write'); writeFileSync(fd, data); },
      fsync: (fd) => { events.push(descriptors.get(fd) === dir ? 'fsync-directory' : descriptors.get(fd) === keyPath ? 'fsync-key' : 'fsync-temp'); fsyncSync(fd); },
      close: (fd) => { closeSync(fd); descriptors.delete(fd); },
      link: (source, destination) => { events.push('publish'); linkSync(source, destination); },
      unlink: (path) => { events.push('unlink-temp'); unlinkSync(path); },
      read: readFileSync,
      random: () => key,
      tempPath: () => join(dir, `.master-key-test-${serial++}`),
    });

    assert.deepEqual(result, key);
    assert.deepEqual(readFileSync(keyPath), key);
    assert.ok(events.indexOf('fsync-temp') < events.indexOf('publish'));
    assert.ok(events.indexOf('publish') < events.indexOf('fsync-key'));
    assert.ok(events.indexOf('fsync-key') < events.indexOf('fsync-directory'));
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);

    const replacement = Buffer.alloc(32, 9);
    assert.deepEqual(loadOrCreateMasterKey(keyPath, {
      mkdir: mkdirSync,
      open: openSync,
      write: (fd, data) => writeFileSync(fd, data),
      fsync: fsyncSync,
      close: closeSync,
      link: linkSync,
      unlink: unlinkSync,
      read: readFileSync,
      random: () => replacement,
      tempPath: () => join(dir, `.master-key-race-${serial++}`),
    }), key);
    assert.deepEqual(readFileSync(keyPath), key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
