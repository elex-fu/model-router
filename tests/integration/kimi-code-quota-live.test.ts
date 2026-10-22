import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchCnProviderQuota } from '../../src/saas/supply/cn-providers-quota-worker.js';

const enabled = process.env.RUN_KIMI_CODE_QUOTA_SMOKE === '1';

test('Kimi Coding live quota returns a bounded rolling/weekly scheduling observation', {
  skip: !enabled ? 'Set RUN_KIMI_CODE_QUOTA_SMOKE=1 to opt in' : false,
  timeout: 20_000,
}, async () => {
  const credential = process.env.KIMI_CODE_API_KEY;
  assert.ok(credential, 'KIMI_CODE_API_KEY is required for the opted-in quota smoke');
  const secret = Buffer.from(credential);
  try {
    const result = await fetchCnProviderQuota('kimi', secret);
    assert.equal(result.state, 'ok', result.state === 'failed' ? result.errorCode : 'quota fetch failed');
    if (result.state !== 'ok') return;
    assert.equal(result.httpStatus, 200);
    assert.ok(result.fiveHour !== null || result.weekly !== null, 'at least one quota window must be observed');
    for (const window of [result.fiveHour, result.weekly]) {
      if (window === null) continue;
      assert.ok(Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100);
      assert.ok(window.resetAt === '' || Number.isFinite(Date.parse(window.resetAt)));
    }
  } finally {
    secret.fill(0);
  }
});
