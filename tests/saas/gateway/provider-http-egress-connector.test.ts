import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { test } from 'node:test';
import {
  createProviderEgressProxyConnection,
  createProviderHttpTestAddressCapability,
  type ProviderHttpAddressResolver,
  ProviderHttpEgressProxyError,
  resolveEgressProxyTarget,
  validateEgressProxyUrl,
} from '../../../src/saas/gateway/provider-http-address.js';

/**
 * R3 connector-level tests: a request issued with the egress dispatcher must
 * travel through the tunnel (mock HTTP proxy in absolute-form mode, mock
 * SOCKS5 server in CONNECT mode), the proxy host is whitelist-validated with
 * the same SSRF policy as provider endpoints, and socks5 upgrades to socks5h.
 */

// The test capability only gates loopback literals for these connector
// tests; no TLS is performed (http targets), so a marker CA string suffices
// (the same TEST_CA marker the runtime capability tests use). NODE_TEST_CONTEXT
// is set by the test runner for the whole child process; NODE_ENV must be
// pinned before the capability is minted because the capability check
// re-validates the environment on every later use.
process.env.NODE_ENV = 'test';
const TEST_CAPABILITY = createProviderHttpTestAddressCapability(
  '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
);

const loopbackResolver: ProviderHttpAddressResolver = async (hostname) =>
  hostname === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : [];

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function trackSockets(server: net.Server): void {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  (server as net.Server & { destroyTracked?: () => void }).destroyTracked = () => {
    for (const socket of sockets) socket.destroy();
  };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    (server as net.Server & { destroyTracked?: () => void }).destroyTracked?.();
    server.close(() => resolve(undefined));
    server.closeAllConnections?.();
  });
}

interface MockTarget {
  readonly port: number;
  readonly server: http.Server;
  readonly requests: string[];
}

async function startMockTarget(): Promise<MockTarget> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target: true }));
  });
  trackSockets(server);
  const port = await listen(server);
  return { port, server, requests };
}

interface MockHttpProxy {
  readonly port: number;
  readonly server: http.Server;
  readonly seenUrls: string[];
}

async function startMockHttpProxy(): Promise<MockHttpProxy> {
  const seenUrls: string[] = [];
  const server = http.createServer((req, res) => {
    seenUrls.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: true }));
  });
  // The production ProxyAgent path tunnels through CONNECT.
  server.on('connect', (req, clientSocket, head) => {
    seenUrls.push(req.url ?? '');
    const [, portText] = (req.url ?? '').split(':');
    const upstream = net.connect({ host: '127.0.0.1', port: Number(portText) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  trackSockets(server);
  const port = await listen(server);
  return { port, server, seenUrls };
}

test('validateEgressProxyUrl upgrades socks5 to socks5h and rejects other schemes', () => {
  const upgraded = validateEgressProxyUrl('socks5://user:pass@proxy.example:1080');
  assert.equal(upgraded.protocol, 'socks5h');
  assert.equal(upgraded.url, 'socks5h://user:pass@proxy.example:1080');
  assert.equal(upgraded.username, 'user');
  assert.equal(upgraded.password, 'pass');
  assert.deepEqual(validateEgressProxyUrl('http://proxy.example'), {
    url: 'http://proxy.example:80',
    hostname: 'proxy.example',
    port: 80,
    protocol: 'http',
    username: '',
    password: '',
  });
  assert.equal(validateEgressProxyUrl('https://proxy.example').port, 443);
  for (const invalid of [
    '',
    'ftp://proxy.example:1',
    'http://proxy.example/path',
    'http://proxy.example?q=1',
    'not a url',
    5,
  ]) {
    assert.throws(() => validateEgressProxyUrl(invalid), ProviderHttpEgressProxyError);
  }
});

test('resolveEgressProxyTarget applies the same SSRF whitelist as provider endpoints', async () => {
  // Loopback requires the test capability.
  await assert.rejects(
    resolveEgressProxyTarget({ url: 'http://127.0.0.1:8080' }, { resolveAddresses: loopbackResolver }),
    ProviderHttpEgressProxyError,
  );
  const loopback = await resolveEgressProxyTarget(
    { url: 'http://127.0.0.1:8080' },
    {
      resolveAddresses: loopbackResolver,
      testCapability: TEST_CAPABILITY,
    },
  );
  assert.equal(loopback.address, '127.0.0.1');
  assert.equal(loopback.family, 4);
  // A name resolving to a private address is rejected without the capability.
  const privateResolver: ProviderHttpAddressResolver = async () => [{ address: '10.1.2.3', family: 4 }];
  await assert.rejects(
    resolveEgressProxyTarget({ url: 'http://proxy.internal:8080' }, { resolveAddresses: privateResolver }),
    ProviderHttpEgressProxyError,
  );
  // A public literal is pinned directly.
  const publicLiteral = await resolveEgressProxyTarget(
    { url: 'http://8.8.8.8:3128' },
    {
      resolveAddresses: loopbackResolver,
    },
  );
  assert.equal(publicLiteral.address, '8.8.8.8');
});

test('an http egress dispatcher routes the request through the proxy tunnel', async () => {
  const target = await startMockTarget();
  const proxy = await startMockHttpProxy();
  try {
    const connection = await createProviderEgressProxyConnection(
      { url: `http://user:secret@127.0.0.1:${proxy.port}` },
      { testCapability: TEST_CAPABILITY, resolveAddresses: loopbackResolver },
    );
    try {
      const response = await fetch(`http://target.example:${target.port}/probe`, {
        method: 'GET',
        dispatcher: connection.dispatcher,
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { target?: boolean };
      assert.equal(body.target, true);
      assert.deepEqual(target.requests, ['/probe']);
      // The proxy observed the CONNECT tunnel request for the target host.
      assert.equal(proxy.seenUrls.length, 1);
      assert.equal(proxy.seenUrls[0], `target.example:${target.port}`);
    } finally {
      await connection.close();
    }
  } finally {
    await closeServer(proxy.server);
    await closeServer(target.server);
  }
});

interface MockSocksServer {
  readonly port: number;
  readonly server: net.Server;
  readonly observed: {
    authExercised: boolean;
    authAccepted: boolean;
    atyp: number | null;
    domain: string | null;
    port: number | null;
  };
}

/**
 * A minimal SOCKS5 server: no-auth or RFC 1929 auth, then relays the tunnel
 * to the requested target. Records the CONNECT address type so the test can
 * prove socks5h remote-DNS semantics (DOMAINNAME, never a resolved IP).
 */
async function startMockSocksServer(options: { readonly requireAuth: boolean }): Promise<MockSocksServer> {
  const observed = {
    authExercised: false,
    authAccepted: false,
    atyp: null as number | null,
    domain: null as string | null,
    port: null as number | null,
  };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'connect' | 'tunnel' = 'greeting';
    let relay: net.Socket | null = null;
    const fail = () => socket.destroy();
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'tunnel') return; // piped to the relay
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const version = buffer[0];
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) return;
        const methods = buffer.subarray(2, 2 + methodCount);
        buffer = buffer.subarray(2 + methodCount);
        assert.equal(version, 5);
        if (options.requireAuth) {
          if (!methods.includes(0x02)) return fail();
          observed.authExercised = true;
          stage = 'auth';
          socket.write(Buffer.from([0x05, 0x02]));
          return;
        }
        if (!methods.includes(0x00)) return fail();
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'connect';
        return;
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1];
        if (buffer.length < 2 + userLength + 1) return;
        const username = buffer.subarray(2, 2 + userLength).toString('utf8');
        const passLength = buffer[2 + userLength];
        if (buffer.length < 2 + userLength + 1 + passLength) return;
        const password = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8');
        buffer = buffer.subarray(3 + userLength + passLength);
        observed.authAccepted = username === 'proxyuser' && password === 'proxypass';
        socket.write(Buffer.from([0x01, observed.authAccepted ? 0x00 : 0x01]));
        if (!observed.authAccepted) return fail();
        stage = 'connect';
        return;
      }
      // connect
      if (buffer.length < 5) return;
      assert.equal(buffer[0], 5);
      assert.equal(buffer[1], 0x01);
      const atyp = buffer[3];
      observed.atyp = atyp;
      let offset = 4;
      let host: string;
      if (atyp === 0x03) {
        const length = buffer[4];
        if (buffer.length < 5 + length + 2) return;
        host = buffer.subarray(5, 5 + length).toString('ascii');
        observed.domain = host;
        offset = 5 + length;
      } else if (atyp === 0x01) {
        if (buffer.length < 4 + 4 + 2) return;
        host = buffer.subarray(4, 8).join('.');
        offset = 8;
      } else {
        return fail();
      }
      const port = buffer.readUInt16BE(offset);
      observed.port = port;
      buffer = buffer.subarray(offset + 2);
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      relay = net.connect({ host: '127.0.0.1', port });
      stage = 'tunnel';
      relay.pipe(socket);
      socket.pipe(relay);
      relay.on('error', fail);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => relay?.destroy());
  });
  trackSockets(server);
  const port = await listen(server);
  return { port, server, observed };
}

test('a socks5h egress dispatcher relays through the socks tunnel with remote DNS', async () => {
  const target = await startMockTarget();
  const socks = await startMockSocksServer({ requireAuth: false });
  try {
    // socks5 in the descriptor: the factory must upgrade to socks5h.
    const connection = await createProviderEgressProxyConnection(
      { url: `socks5://127.0.0.1:${socks.port}` },
      { testCapability: TEST_CAPABILITY, resolveAddresses: loopbackResolver },
    );
    try {
      const response = await fetch(`http://destination.example:${target.port}/check`, {
        method: 'GET',
        dispatcher: connection.dispatcher,
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { target?: boolean };
      assert.equal(body.target, true);
      assert.deepEqual(target.requests, ['/check']);
      // socks5h proof: the domain was sent to the proxy (ATYP 0x03), never
      // resolved locally to an IP literal.
      assert.equal(socks.observed.atyp, 0x03);
      assert.equal(socks.observed.domain, 'destination.example');
      assert.equal(socks.observed.port, target.port);
    } finally {
      await connection.close();
    }
  } finally {
    await closeServer(socks.server);
    await closeServer(target.server);
  }
});

test('a socks5h dispatcher exercises RFC 1929 credentials and fails closed on rejection', async () => {
  const target = await startMockTarget();
  const socks = await startMockSocksServer({ requireAuth: true });
  try {
    const connection = await createProviderEgressProxyConnection(
      { url: `socks5h://proxyuser:proxypass@127.0.0.1:${socks.port}` },
      { testCapability: TEST_CAPABILITY, resolveAddresses: loopbackResolver },
    );
    try {
      const response = await fetch(`http://destination.example:${target.port}/authed`, {
        method: 'GET',
        dispatcher: connection.dispatcher,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(target.requests, ['/authed']);
      assert.ok(socks.observed.authExercised);
      assert.ok(socks.observed.authAccepted);
    } finally {
      await connection.close();
    }
    // Wrong credentials: the proxy rejects the handshake and the request fails.
    const rejected = await createProviderEgressProxyConnection(
      { url: `socks5h://proxyuser:wrongpass@127.0.0.1:${socks.port}` },
      { testCapability: TEST_CAPABILITY, resolveAddresses: loopbackResolver },
    );
    try {
      await assert.rejects(
        fetch(`http://destination.example:${target.port}/nope`, { method: 'GET', dispatcher: rejected.dispatcher }),
      );
    } finally {
      await rejected.close();
    }
  } finally {
    await closeServer(socks.server);
    await closeServer(target.server);
  }
});
