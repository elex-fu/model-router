import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSaasBackupHttpHandler } from '../../../src/saas/backup/http.js';
import { getSaasBackupStatus } from '../../../src/saas/backup/service.js';
import { saasBackupClient } from '../../../web/src/api/saas-backup-client.js';

test('backup status is authenticated, read-only, and accepted by the real shared web client', async (context) => {
  const handler = createSaasBackupHttpHandler({
    access: {
      authenticate: async (request) =>
        request.headers.authorization === 'Bearer fixture-session'
          ? { userId: 'fixture-operator', sessionId: 'fixture-session', roles: ['operations'] }
          : undefined,
    },
    status: () => getSaasBackupStatus({}, { env: {} }),
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${url}/admin/api/v1/ops/backups`)).status, 401);
    const headers = { authorization: 'Bearer fixture-session' };
    const status = await fetch(`${url}/admin/api/v1/ops/backups`, { headers });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(((await status.json()) as { data: { configured: boolean } }).data.configured, false);
    assert.equal((await fetch(`${url}/admin/api/v1/ops/backups`, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(`${url}/admin/api/v1/ops/another-route`, { headers })).status, 404);
    const actualFetch = globalThis.fetch;
    context.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) =>
      actualFetch(new URL(String(input), url), init),
    );
    const clientStatus = await saasBackupClient.status({ bearerToken: 'fixture-session' });
    assert.equal(clientStatus.format, 'saas-backup-status-v1');
    assert.equal(clientStatus.configured, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('backup status errors expose only a sanitized unavailability code', async () => {
  const handler = createSaasBackupHttpHandler({
    access: { authenticate: async () => ({ userId: 'operator', sessionId: 'fixture', roles: ['operations'] }) },
    status: async () => {
      throw new Error('private operator evidence path must not leak');
    },
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/v1/ops/backups`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /BACKUP_STATUS_UNAVAILABLE/);
    assert.ok(!body.includes('private operator evidence path'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
