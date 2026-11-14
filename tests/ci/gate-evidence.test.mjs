import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { completeGateRun, parseGateCounts, promotableGateRun, sourceIdentity } from '../../scripts/ci/gate-evidence.mjs';

const counts = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1.2 };
const source = { sha: 'a'.repeat(40), clean: true, fingerprint: 'f'.repeat(64) };

test('release evidence requires native complete counts, zero skips and zero todos', () => {
  const output = Object.entries(counts).map(([key, value]) => `ℹ ${key} ${value}`).join('\n');
  assert.deepEqual(parseGateCounts(output), counts);
  assert.equal(completeGateRun(0, counts), true);
  for (const change of [{ tests: 0, pass: 0 }, { pass: 2, skipped: 1 }, { todo: 1 }, { cancelled: 1 }, { fail: 1 }]) {
    assert.equal(completeGateRun(0, { ...counts, ...change }), false);
  }
  assert.equal(completeGateRun(null, counts), false);
  assert.equal(completeGateRun(1, counts), false);
  assert.equal(completeGateRun(0, parseGateCounts('')), false);
  assert.equal(completeGateRun(0, parseGateCounts(`${output}\n${output}`)), false);
});

test('a historical SHA, dirty source or source changes cannot be promoted', () => {
  assert.equal(promotableGateRun(0, counts, source, source), true);
  for (const change of [{ sha: 'b'.repeat(40) }, { clean: false }, { fingerprint: 'e'.repeat(64) }]) {
    assert.equal(promotableGateRun(0, counts, source, { ...source, ...change }), false);
    assert.equal(promotableGateRun(0, counts, { ...source, ...change }, source), false);
  }
});

test('source identity detects edits to an already dirty file without retaining its bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-router-source-identity-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init', '-q');
    writeFileSync(join(root, 'fixture.txt'), 'committed');
    git('add', '.');
    git('-c', 'user.name=Gate Fixture', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'fixture');
    assert.equal(sourceIdentity(root).clean, true);
    writeFileSync(join(root, 'fixture.txt'), 'dirty one');
    const before = sourceIdentity(root);
    writeFileSync(join(root, 'fixture.txt'), 'dirty two');
    const after = sourceIdentity(root);
    assert.equal(before.clean, false);
    assert.equal(after.clean, false);
    assert.equal(before.sha, after.sha);
    assert.notEqual(before.fingerprint, after.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
