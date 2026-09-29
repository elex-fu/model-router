import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminRequestRateLimiter, createAdminServer } from '../../src/admin/server.js';

test('management request limiter admits within the window and resets after expiry', () => {
  const limiter = new AdminRequestRateLimiter();
  for (let i = 0; i < 120; i++) assert.equal(limiter.take('client-a', 1_000), undefined);
  assert.equal(limiter.take('client-a', 1_000), 60);
  assert.equal(limiter.take('client-a', 30_001), 31);
  assert.equal(limiter.take('client-a', 61_000), undefined);
  assert.equal(limiter.take('client-b', 1_000), undefined);
});

test('management API limit responds with the documented 429 error and Retry-After', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-rate-limit-'));
  const app = createAdminServer({ configPath: join(dir, 'config.json') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/admin/api/v1/bootstrap`;
  try {
    for (let i = 0; i < 120; i++) assert.equal((await fetch(endpoint)).status, 200);
    const limited = await fetch(endpoint);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    const payload = (await limited.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    assert.equal(payload.error.code, 'ADMIN_RATE_LIMITED');
    assert.equal(payload.error.message, 'Too many management API requests');
    assert.match(payload.error.requestId, /^admin_/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
