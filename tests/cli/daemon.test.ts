import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readPidFile,
  isProcessRunning,
  writePidFile,
} from '../../src/cli/daemon.js';

function tmpPath(): string {
  return path.join(os.tmpdir(), `mr-daemon-${randomUUID()}.pid`);
}

test('readPidFile: missing file returns null', () => {
  const p = tmpPath();
  assert.equal(readPidFile(p), null);
});

test('readPidFile: returns pid for valid file', () => {
  const p = tmpPath();
  fs.writeFileSync(p, '12345\n');
  try {
    assert.equal(readPidFile(p), 12345);
  } finally {
    fs.unlinkSync(p);
  }
});

test('readPidFile: garbage file returns null', () => {
  const p = tmpPath();
  fs.writeFileSync(p, 'not-a-number');
  try {
    assert.equal(readPidFile(p), null);
  } finally {
    fs.unlinkSync(p);
  }
});

test('writePidFile: writes pid as text and chmods 0600', () => {
  const p = tmpPath();
  try {
    writePidFile(p, 4242);
    const content = fs.readFileSync(p, 'utf-8');
    assert.equal(content.trim(), '4242');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

test('isProcessRunning: own process is running', () => {
  assert.equal(isProcessRunning(process.pid), true);
});

test('isProcessRunning: nonexistent pid returns false', () => {
  // 0 isn't a valid pid for this purpose; pick a high one unlikely to exist.
  // We try a few candidates and accept any that returns false.
  let found = false;
  for (const candidate of [9999991, 9999992, 9999993]) {
    if (!isProcessRunning(candidate)) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'expected at least one nonexistent pid');
});
