import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { runLegacy112Acceptance } from '../../../scripts/drills/legacy-112-compat-acceptance.js';

/**
 * PG-gated live acceptance for the legacy-main-112-to-129 compat plan
 * (plan §5.2 acceptance bar). Opt-in because it provisions a throwaway
 * initdb PostgreSQL cluster (loopback, trust auth, port 55443+) and builds
 * seven real databases:
 *
 *   LEGACY_112_COMPAT_ACCEPTANCE=1 npm test -- tests/saas/db/migrate-compat-legacy-112.integration.test.ts
 *
 * (equivalently: `node --import tsx scripts/drills/legacy-112-compat-acceptance.ts`).
 */
const gate = process.env.LEGACY_112_COMPAT_ACCEPTANCE === '1';

function initdbAvailable(): boolean {
  try {
    execFileSync('initdb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('legacy-main-112-to-129 compat plan live acceptance (three real databases + fault injection)', {
  skip: gate ? false : 'set LEGACY_112_COMPAT_ACCEPTANCE=1 (and have initdb on PATH) to run the live acceptance',
}, async () => {
  assert.ok(initdbAvailable(), 'initdb must be on PATH for the live acceptance');
  const result = await runLegacy112Acceptance();
  const failed = result.checks.filter((check) => check.status === 'fail');
  for (const check of result.checks) {
    assert.equal(check.status, 'pass', `${check.name} failed: ${check.detail}`);
  }
  assert.ok(result.checks.length >= 15, `expected the full acceptance matrix, got ${result.checks.length} checks`);
  assert.ok(result.ok, `acceptance failed: ${failed.map((check) => check.name).join(', ')}`);
});
