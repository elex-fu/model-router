import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fetch } from 'undici';
import { FastPinnedConnectorPool } from '../../../../src/saas/gateway/fast/pinned-connector-pool.js';
import {
  createPinnedProviderHttpTestConnectorFactory,
  createProviderHttpTestAddressCapability,
  selectPinnedProviderAddress,
} from '../../../../src/saas/gateway/provider-http-address.js';

process.env.NODE_ENV = 'test';
test('real pinned HTTPS keeps one TLS connection across completed requests without bypassing address policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fast-pinned-pool-'));
  const key = join(directory, 'key.pem'),
    cert = join(directory, 'cert.pem');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
    res.end('ok');
  });
  let connections = 0;
  server.on('secureConnection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const capability = createProviderHttpTestAddressCapability(await readFile(cert, 'utf8'));
  const base = createPinnedProviderHttpTestConnectorFactory(capability);
  const pool = new FastPinnedConnectorPool({ createConnector: base, maximumEntries: 4 });
  try {
    for (let i = 0; i < 2; i++) {
      // Same address-policy decision still runs for EVERY request, before borrow.
      const address = selectPinnedProviderAddress('127.0.0.1', [], capability);
      const connector = pool.createConnector({ hostname: '127.0.0.1', port, ...address });
      const response = await fetch(`https://127.0.0.1:${port}/`, { dispatcher: connector.dispatcher });
      assert.equal(await response.text(), 'ok');
      await connector.close();
    }
    assert.equal(connections, 1, 'TLS connection, not just dispatcher object, is reused');
    assert.throws(
      () => selectPinnedProviderAddress('127.0.0.1', []),
      'pool does not create a loopback policy exemption',
    );
    for (let i = 0; i < 2; i++) {
      const connector = base({ hostname: '127.0.0.1', port, address: '127.0.0.1', family: 4 });
      assert.equal(
        await (await fetch(`https://127.0.0.1:${port}/`, { dispatcher: connector.dispatcher })).text(),
        'ok',
      );
      await connector.close();
    }
    assert.equal(connections, 3, 'unpooled control opens a fresh TLS connection per request');
  } finally {
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
