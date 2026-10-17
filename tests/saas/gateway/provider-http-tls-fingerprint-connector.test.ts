import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildSidecarDialRequest,
  createTlsFingerprintSidecarConnectorFactory,
  DEFAULT_TLS_FINGERPRINT_SIDECAR_CONNECT_TIMEOUT_MS,
  isProviderTlsFingerprintEgress,
  type ProviderTlsFingerprintEgress,
  sidecarDial,
  TlsFingerprintSidecarError,
} from '../../../src/saas/gateway/provider-http-tls-fingerprint-connector.js';

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function readFrame(socket: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.byteLength < 4 + length) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      try {
        resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      socket.removeListener('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

describe('isProviderTlsFingerprintEgress (strict shape validation)', () => {
  it('accepts default and random selectors with exactly one key', () => {
    assert.equal(isProviderTlsFingerprintEgress({ selector: 'default' }), true);
    assert.equal(isProviderTlsFingerprintEgress({ selector: 'random' }), true);
  });

  it('accepts custom selectors with a well-formed profile', () => {
    assert.equal(
      isProviderTlsFingerprintEgress({
        selector: 'custom',
        profile: { name: 'node24', enableGrease: true, cipherSuites: [4865, 4866], alpnProtocols: ['http/1.1'] },
      }),
      true,
    );
  });

  it('rejects malformed descriptors fail-closed', () => {
    const bad: unknown[] = [
      null,
      'default',
      {},
      { selector: 'off' },
      { selector: 'default', profile: {} },
      { selector: 'custom' },
      { selector: 'custom', profile: null },
      { selector: 'custom', profile: { cipherSuites: ['x'] } },
      { selector: 'custom', profile: { cipherSuites: new Array(65).fill(1) } },
      { selector: 'custom', profile: { name: 'x' }, extra: 1 },
    ];
    for (const value of bad) {
      assert.equal(isProviderTlsFingerprintEgress(value), false, JSON.stringify(value));
    }
  });
});

describe('buildSidecarDialRequest (wire mapping)', () => {
  it('maps the default selector with no profile payload', () => {
    const request = buildSidecarDialRequest({
      hostname: 'api.anthropic.com',
      port: 443,
      fingerprint: { selector: 'default' },
    });
    assert.deepEqual(request, { host: 'api.anthropic.com', port: 443, profile_id: 'default' });
  });

  it('maps a custom profile with the migration-116 column spellings', () => {
    const request = buildSidecarDialRequest({
      hostname: 'api.anthropic.com',
      port: 443,
      fingerprint: {
        selector: 'custom',
        profile: {
          name: 'macos-node',
          enableGrease: true,
          cipherSuites: [4865, 4866],
          signatureAlgorithms: [1027],
          alpnProtocols: ['http/1.1'],
          extensions: [0, 16, 51],
        },
      },
      proxyUrl: 'socks5h://proxy.example.com:1080',
    });
    const profile = request.profile as Record<string, unknown>;
    assert.equal(profile.name, 'macos-node');
    assert.equal(profile.enable_grease, true);
    assert.deepEqual(profile.cipher_suites, [4865, 4866]);
    assert.deepEqual(profile.signature_algorithms, [1027]);
    assert.deepEqual(profile.alpn_protocols, ['http/1.1']);
    assert.deepEqual(profile.extensions, [0, 16, 51]);
    assert.equal(profile.curves, undefined);
    assert.equal(request.proxy_url, 'socks5h://proxy.example.com:1080');
  });
});

describe('sidecarDial (IPC frame protocol over a Unix socket)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsfp-'));
  const socketPath = path.join(dir, 's.sock');
  let server: net.Server | undefined;
  const trackedSockets = new Set<net.Socket>();

  const startServer = async (handler: (socket: net.Socket) => void): Promise<void> => {
    // One server at a time on the shared socket path: close the previous one
    // (destroying its connections) before listening again.
    await closeServer();
    await new Promise<void>((resolve, reject) => {
      const next = net.createServer((socket) => {
        trackedSockets.add(socket);
        socket.on('close', () => trackedSockets.delete(socket));
        handler(socket);
      });
      next.once('error', reject);
      next.listen(socketPath, () => {
        next.removeListener('error', reject);
        next.on('error', () => undefined);
        resolve();
      });
      server = next;
    });
  };

  const closeServer = async (): Promise<void> => {
    const current = server;
    server = undefined;
    if (current === undefined) return;
    for (const socket of [...trackedSockets]) socket.destroy();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  };

  after(async () => {
    await closeServer();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exchanges the frame protocol and then relays raw tunnel bytes', async () => {
    let sawRequest: Record<string, unknown> = {};
    await startServer((socket) => {
      void readFrame(socket).then((request) => {
        sawRequest = request;
        socket.write(frame('{"ok":true}'));
        // Tunnel bytes both directions after the response frame.
        socket.write(Buffer.from('server-hello'));
        socket.on('data', (chunk) => {
          socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
        });
      });
    });

    const result = await new Promise<{ error: Error | null; socket: net.Socket | null }>((resolve) => {
      const socket = sidecarDial(
        { socketPath },
        { host: 'api.anthropic.com', port: 443, profile_id: 'default' },
        (error, tunnel) => resolve({ error, socket: tunnel ?? null }),
      );
      socket.on('error', () => undefined);
    });
    assert.equal(result.error, null);
    assert.ok(result.socket);
    assert.equal(sawRequest.profile_id, 'default');

    const readNext = (): Promise<Buffer> =>
      new Promise((resolve) => {
        result.socket?.once('data', (chunk: Buffer) => resolve(chunk));
      });
    // The server-hello tunnel bytes arrive first; then the echo of ping.
    const first = readNext();
    const hello = await first;
    assert.equal(hello.toString('utf8'), 'server-hello');
    const echo = readNext();
    result.socket?.write(Buffer.from('ping'));
    assert.equal((await echo).toString('utf8'), 'echo:ping');
    result.socket?.destroy();
  });

  it('rejects a dial-rejected response with DIAL_REJECTED', async () => {
    await startServer((socket) => {
      void readFrame(socket).then(() => {
        socket.write(frame('{"ok":false,"error":"dial failed"}'));
        socket.end();
      });
    });
    const result = await new Promise<{ error: Error | null }>((resolve) => {
      const socket = sidecarDial({ socketPath }, { host: 'x', port: 1, profile_id: 'default' }, (error) =>
        resolve({ error }),
      );
      socket.on('error', () => undefined);
    });
    assert.ok(result.error instanceof TlsFingerprintSidecarError);
    assert.equal((result.error as TlsFingerprintSidecarError).code, 'DIAL_REJECTED');
  });

  it('rejects a malformed response frame with PROTOCOL_ERROR', async () => {
    await startServer((socket) => {
      void readFrame(socket).then(() => {
        socket.write('this is not a frame');
      });
    });
    const result = await new Promise<{ error: Error | null }>((resolve) => {
      const socket = sidecarDial({ socketPath }, { host: 'x', port: 1, profile_id: 'default' }, (error) =>
        resolve({ error }),
      );
      socket.on('error', () => undefined);
    });
    assert.ok(result.error instanceof TlsFingerprintSidecarError);
    assert.equal((result.error as TlsFingerprintSidecarError).code, 'PROTOCOL_ERROR');
  });

  it('rejects an out-of-bounds frame header', async () => {
    await startServer((socket) => {
      void readFrame(socket).then(() => {
        const header = Buffer.alloc(4);
        // 65_537 is one past the 64 KiB frame bound (exactly 65_536 is legal).
        header.writeUInt32BE(65_537, 0);
        socket.write(header);
      });
    });
    const result = await new Promise<{ error: Error | null }>((resolve) => {
      const socket = sidecarDial({ socketPath }, { host: 'x', port: 1, profile_id: 'default' }, (error) =>
        resolve({ error }),
      );
      socket.on('error', () => undefined);
    });
    assert.ok(result.error instanceof TlsFingerprintSidecarError);
    assert.equal((result.error as TlsFingerprintSidecarError).code, 'PROTOCOL_ERROR');
  });

  it('times out with CONNECT_TIMEOUT when the sidecar never answers', async () => {
    await startServer((socket) => {
      socket.on('data', () => undefined); // swallow the request, never answer
    });
    const result = await new Promise<{ error: Error | null }>((resolve) => {
      const socket = sidecarDial(
        { socketPath, connectTimeoutMs: 50 },
        { host: 'x', port: 1, profile_id: 'default' },
        (error) => resolve({ error }),
      );
      socket.on('error', () => undefined);
    });
    assert.ok(result.error instanceof TlsFingerprintSidecarError);
    assert.equal((result.error as TlsFingerprintSidecarError).code, 'CONNECT_TIMEOUT');
    assert.equal(DEFAULT_TLS_FINGERPRINT_SIDECAR_CONNECT_TIMEOUT_MS, 10_000);
  });
});

describe('createTlsFingerprintSidecarConnectorFactory (fallback matrix)', () => {
  const fingerprint: ProviderTlsFingerprintEgress = { selector: 'default' };

  const baseInput = {
    hostname: 'api.anthropic.com',
    address: '1.2.3.4',
    family: 4 as const,
    port: 443,
  };

  const closeConnector = (connector: { close(): Promise<void> }): Promise<void> =>
    connector.close().catch(() => undefined);

  it('requires a socket path', () => {
    assert.throws(() => createTlsFingerprintSidecarConnectorFactory({ socketPath: '' }));
  });

  it('without a fingerprint the ordinary pinned connector path is used (no sidecar socket needed)', async () => {
    const factory = createTlsFingerprintSidecarConnectorFactory({ socketPath: '/nonexistent/s.sock' });
    const connector = factory(baseInput);
    assert.ok(connector.dispatcher);
    await closeConnector(connector);
  });

  it('with an https proxy and a fingerprint the connector falls back to the ordinary proxy path', async () => {
    const factory = createTlsFingerprintSidecarConnectorFactory({ socketPath: '/nonexistent/s.sock' });
    const connector = factory({
      ...baseInput,
      proxy: {
        url: 'https://proxy.example.com:443',
        hostname: 'proxy.example.com',
        port: 443,
        address: '5.6.7.8',
        family: 4,
        protocol: 'https',
        username: '',
        password: '',
      },
      tlsFingerprint: fingerprint,
    });
    // The ordinary pinned proxy connector builds without touching the socket.
    assert.ok(connector.dispatcher);
    await closeConnector(connector);
  });

  it('with a fingerprint and direct egress the sidecar connector builds (dial happens per connection)', async () => {
    const factory = createTlsFingerprintSidecarConnectorFactory({ socketPath: '/nonexistent/s.sock' });
    const connector = factory({ ...baseInput, tlsFingerprint: fingerprint });
    assert.ok(connector.dispatcher);
    await closeConnector(connector);
  });
});
