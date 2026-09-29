import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';

test('admin static assets, SPA fallback and traversal boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-static-'));
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>console</html>');
  writeFileSync(join(dist, 'app.js'), 'console.log(1)');
  writeFileSync(join(dist, 'config.json'), '{"secret":"private"}');
  writeFileSync(join(dist, 'config.json.v1.123.bak'), 'private-backup');
  mkdirSync(join(dist, 'admin-exports'));
  writeFileSync(join(dist, 'admin-exports', 'sample.json'), '{"private":true}');
  mkdirSync(join(dist, 'admin-backups'));
  writeFileSync(join(dist, 'admin-backups', 'manifest.json'), '{"private":true}');
  writeFileSync(join(dir, 'private.txt'), 'private-data');
  symlinkSync(join(dir, 'private.txt'), join(dist, 'leak.txt'));
  const app = createAdminServer({ configPath: join(dir, 'config.json'), webDistPath: dist });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(`${base}/admin/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /console/);
    const asset = await fetch(`${base}/admin/app.js`);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const page = await fetch(`${base}/admin/routes/first`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /console/);
    assert.equal((await fetch(`${base}/admin/api/unknown`, { headers: { accept: 'text/html' } })).status, 404);
    assert.equal((await fetch(`${base}/admin/nope.js`, { headers: { accept: 'text/html' } })).status, 404);
    assert.equal((await fetch(`${base}/admin/leak.txt`)).status, 404);
    assert.equal((await fetch(`${base}/admin/config.json`)).status, 404);
    assert.equal((await fetch(`${base}/admin/config.json.v1.123.bak`)).status, 404);
    assert.equal((await fetch(`${base}/admin/admin-exports/sample.json`)).status, 404);
    assert.equal((await fetch(`${base}/admin/admin-backups/manifest.json`)).status, 404);
    assert.equal((await fetch(`${base}/admin/%2e%2e/private.txt`)).status, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
