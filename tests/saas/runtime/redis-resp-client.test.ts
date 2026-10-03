import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer as createTlsServer } from 'node:tls';
import { decodeRedisResp2, REDIS_RESP_BOUNDS, RedisRespClient, RedisRespError,
  type RedisRespValue } from '../../../src/saas/runtime/redis-resp-client.js';

// These tests open only ephemeral owned loopback fixtures, never a Redis
// instance or user configuration. The server speaks synthetic RESP2 replies.
async function fixture(t: TestContext, handler: (socket: Socket, command: readonly string[]) => void) {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let failed = false;
  let onAccepted: () => void = () => undefined;
  const accepted = new Promise<void>((resolve) => { onAccepted = resolve; });
  const server = createServer((socket) => {
    connections += 1; sockets.add(socket);
    onAccepted();
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let input: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      try {
        while (input.length > 0) {
          const parsed = decodeRedisResp2(input);
          if (parsed === undefined) return;
          assert.ok(Array.isArray(parsed.value));
          const command = parsed.value.map((part: RedisRespValue) => {
            assert.ok(Buffer.isBuffer(part), 'requests must be arrays of bulk bytes');
            return part.toString('utf8');
          });
          input = Buffer.from(input.subarray(parsed.bytes));
          commands.push(command); handler(socket, command);
        }
      } catch { failed = true; socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic RESP cleanup deadline')), 2_000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    assert.equal(failed, false, 'synthetic server must parse every actual command');
  });
  return { port: address.port, commands, connections: () => connections,
    async waitForAcceptedConnection(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([accepted, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('synthetic RESP accept deadline')), 2_000);
        })]);
      } finally { clearTimeout(timer); }
    } };
}

function safeError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RedisRespError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.stack, 'RedisRespError: ' + code);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('RESP2 known wire frames, binary bulk and nested/null values decode exactly', () => {
  for (const [wire, expected] of [
    ['+PONG\r\n', 'PONG'], [':+42\r\n', 42], [':-2\r\n', -2],
    ['$-1\r\n', null], ['*-1\r\n', null], ['*0\r\n', []],
    ['*3\r\n:1\r\n$-1\r\n*1\r\n+OK\r\n', [1, null, ['OK']]],
  ] as const) {
    const parsed = decodeRedisResp2(Buffer.from(wire));
    assert.ok(parsed);
    assert.deepEqual(parsed.value, expected);
    assert.equal(parsed.bytes, Buffer.byteLength(wire));
  }
  const binary = Buffer.from([0, 13, 10, 255]);
  const parsed = decodeRedisResp2(Buffer.concat([Buffer.from('$4\r\n'), binary, Buffer.from('\r\n')]));
  assert.ok(parsed && Buffer.isBuffer(parsed.value));
  assert.deepEqual(parsed.value, binary);
});

test('every proper prefix of bounded fragmented frames remains incomplete', () => {
  for (const wire of ['+PONG\r\n', ':1001\r\n', '$5\r\nhello\r\n', '*2\r\n:0\r\n:1001\r\n']) {
    const bytes = Buffer.from(wire);
    for (let end = 0; end < bytes.length; end += 1) assert.equal(decodeRedisResp2(bytes.subarray(0, end)), undefined);
    assert.ok(decodeRedisResp2(bytes));
  }
});

test('malformed, RESP3, unsafe integer, oversized and deep frames fail closed', () => {
  for (const wire of [
    '%0\r\n', '_\r\n', ':9007199254740992\r\n', ':1.2\r\n', '$-2\r\n', '*-2\r\n',
    '$9000\r\n', '*33\r\n', '$1\r\nxXX', '+broken\nline\r\n',
    '*1\r\n'.repeat(6) + ':1\r\n', '+' + 'x'.repeat(REDIS_RESP_BOUNDS.lineBytes + 1),
  ]) assert.throws(() => decodeRedisResp2(Buffer.from(wire)), safeError('REDIS_PROTOCOL_ERROR'));
  assert.throws(() => decodeRedisResp2(Buffer.alloc(REDIS_RESP_BOUNDS.bufferBytes + 1)), safeError('REDIS_PROTOCOL_ERROR'));
  assert.throws(() => decodeRedisResp2(Buffer.from('*5\r\n' + ('*32\r\n' + ':0\r\n'.repeat(32)).repeat(5))),
    safeError('REDIS_PROTOCOL_ERROR'));
  assert.throws(() => decodeRedisResp2(Buffer.from('-WRONGPASS synthetic-sensitive-text\r\n')), safeError('REDIS_REPLY_ERROR'));
  assert.throws(() => decodeRedisResp2(Buffer.from('*1\r\n-ERR synthetic-sensitive-text\r\n')), safeError('REDIS_REPLY_ERROR'));
});

test('actual socket sends ACL AUTH, nonzero SELECT and PING with percent-decoded binary-safe arguments', async (t) => {
  const peer = await fixture(t, (socket, command) => socket.write(command[0] === 'PING' ? '+PONG\r\n' : '+OK\r\n'));
  const client = await RedisRespClient.connect('redis://synthetic-user:synthetic%3Apass@127.0.0.1:' + peer.port + '/2');
  t.after(() => client.close());
  assert.equal(await client.command(['PING']), 'PONG');
  assert.equal(peer.commands.length, 3);
  assert.ok(peer.commands[0]?.[0] === 'AUTH' && peer.commands[0]?.[1] === 'synthetic-user' &&
    peer.commands[0]?.[2] === 'synthetic:pass', 'ACL arguments must be decoded exactly, without logging credentials');
  assert.deepEqual(peer.commands.slice(1), [['SELECT', '2'], ['PING']]);
});

test('password-only AUTH and default DB omit SELECT; close is idempotent and refuses commands', async (t) => {
  const peer = await fixture(t, (socket) => socket.write('+OK\r\n'));
  const client = await RedisRespClient.connect('redis://:synthetic-password@127.0.0.1:' + peer.port + '/0');
  assert.ok(peer.commands[0]?.length === 2 && peer.commands[0]?.[0] === 'AUTH');
  assert.equal(peer.commands.some((command) => command[0] === 'SELECT'), false);
  const closing = client.close();
  assert.equal(client.close(), closing);
  await closing;
  await assert.rejects(client.command(['PING']), safeError('REDIS_CLOSED'));
});

test('only one actual socket command is in flight, and fragmented response preserves queued order', async (t) => {
  let release: (() => void) | undefined;
  let received: (() => void) | undefined;
  const first = new Promise<void>((resolve) => { received = resolve; });
  const peer = await fixture(t, (socket, command) => {
    assert.equal(command[0], 'PING');
    if (release === undefined) {
      release = () => { socket.write('+PO'); setImmediate(() => socket.write('NG\r\n')); };
      received?.();
    } else socket.write('+PONG\r\n');
  });
  const client = await RedisRespClient.connect('redis://127.0.0.1:' + peer.port);
  t.after(() => client.close());
  const firstReply = client.command(['PING']);
  const secondReply = client.command(['PING']);
  await first;
  assert.equal(peer.commands.length, 1, 'queued request must not be pipelined before first reply');
  assert.ok(release); release();
  assert.deepEqual(await Promise.all([firstReply, secondReply]), ['PONG', 'PONG']);
});

test('bounded queue rejects overflow before sending; close rejects every outstanding request', async (t) => {
  const peer = await fixture(t, () => undefined);
  const client = await RedisRespClient.connect('redis://127.0.0.1:' + peer.port);
  t.after(() => client.close());
  await peer.waitForAcceptedConnection();
  assert.equal(peer.connections(), 1, 'queue/close begins only after the actual server accept callback');
  const pending = Array.from({ length: REDIS_RESP_BOUNDS.pending }, () => client.command(['PING']));
  const all = Promise.allSettled(pending);
  await assert.rejects(client.command(['PING']), safeError('REDIS_QUEUE_FULL'));
  await client.close();
  for (const result of await all) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.ok(result.reason instanceof RedisRespError);
  }
  assert.equal(peer.connections(), 1);
  assert.ok(peer.commands.length <= 1, 'queue close cannot dispatch the unsent commands');
});

test('purpose command whitelist, one-key restriction and encoded size bound reject before sending', async (t) => {
  const peer = await fixture(t, () => assert.fail('invalid command must never be sent'));
  const client = await RedisRespClient.connect('redis://127.0.0.1:' + peer.port);
  t.after(() => client.close());
  for (const command of [
    ['FLUSHALL'], ['PING', 'extra'], ['EVAL', 'return 1', '2', 'a', 'b', '1'],
    ['EVAL', 'return 1', '0', 'a', '1', '1'],
    ['AUTH', 'x'.repeat(REDIS_RESP_BOUNDS.bufferBytes + 1)],
  ]) await assert.rejects(client.command(command), safeError('REDIS_INVALID_COMMAND'));
  assert.equal(peer.commands.length, 0);
});

test('Redis errors, trailing replies and oversized network responses poison without reconnect/retry', async (t) => {
  for (const [reply, code] of [
    ['-MOVED 1 synthetic-endpoint\r\n', 'REDIS_REPLY_ERROR'],
    ['+PONG\r\n+PONG\r\n', 'REDIS_PROTOCOL_ERROR'],
    ['$20000\r\n', 'REDIS_PROTOCOL_ERROR'],
  ]) {
    const peer = await fixture(t, (socket) => socket.write(reply));
    const client = await RedisRespClient.connect('redis://127.0.0.1:' + peer.port);
    await assert.rejects(client.command(['PING']), safeError(code));
    await assert.rejects(client.command(['PING']), safeError(code));
    await client.close();
    assert.equal(peer.commands.length, 1);
    assert.equal(peer.connections(), 1);
  }
});

test('uncertain EVAL timeout is not automatically replayed and no later command is sent', { timeout: 10_000 }, async (t) => {
  const peer = await fixture(t, () => undefined); // receipt could mean the write already happened.
  const client = await RedisRespClient.connect('redis://127.0.0.1:' + peer.port);
  await assert.rejects(client.command(['EVAL', 'return {1, 10}', '1', 'synthetic-key', '1', '10']), safeError('REDIS_TIMEOUT'));
  await assert.rejects(client.command(['PING']), safeError('REDIS_TIMEOUT'));
  await client.close();
  assert.equal(peer.commands.length, 1);
  assert.equal(peer.connections(), 1);
});

test('AUTH rejection is redacted and never retried', async (t) => {
  const peer = await fixture(t, (socket) => socket.write('-WRONGPASS synthetic-password\r\n'));
  await assert.rejects(RedisRespClient.connect('redis://:synthetic-password@127.0.0.1:' + peer.port), safeError('REDIS_REPLY_ERROR'));
  assert.equal(peer.commands.length, 1);
  assert.equal(peer.connections(), 1);
});

test('strict URL boundaries refuse before opening a socket', async (t) => {
  const peer = await fixture(t, () => assert.fail('invalid URL must not dial'));
  const base = 'redis://127.0.0.1:' + peer.port;
  for (const url of [
    '', base + '?', base + '#', base + '?tls=false', base + '/16', base + '/01', base + '/-1', base + '/socket',
    base + ' ', 'http://127.0.0.1:' + peer.port, 'redis://user@127.0.0.1:' + peer.port,
    'redis://:@127.0.0.1:' + peer.port, 'redis://:bad%ZZ@127.0.0.1:' + peer.port,
    'redis://:bad%00@127.0.0.1:' + peer.port, 'redis://bad_host:6379', 'redis://127.0.0.1:0',
  ]) await assert.rejects(RedisRespClient.connect(url), safeError('REDIS_INVALID_URL'));
  assert.equal(peer.connections(), 0);
});

test('untrusted self-signed TLS is rejected even with a matching IP SAN; no AUTH is exposed', { timeout: 15_000 }, async (t) => {
  // Same local OpenSSL fixture technique as the existing HTTPS suite. Generate
  // only owned synthetic material with a clean env and no user OpenSSL config.
  const directory = await mkdtemp(join(tmpdir(), 'redis-resp-synthetic-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'synthetic.key'); const cert = join(directory, 'synthetic.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-sha256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-config', '/dev/null',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
  { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C' }, stdio: 'ignore', timeout: 5_000 });
  assert.equal(generated.status, 0, 'local synthetic certificate generation must succeed; no skip/fallback');
  let authenticated = false;
  const sockets = new Set<Socket>();
  const server = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (socket) => {
    sockets.add(socket); socket.on('data', () => { authenticated = true; });
    socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket));
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic TLS cleanup deadline')), 2_000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(RedisRespClient.connect('rediss://:synthetic-password@127.0.0.1:' + address.port), safeError('REDIS_TLS_FAILED'));
  assert.equal(authenticated, false, 'untrusted peer must never receive application AUTH bytes');
});

test('TLS handshake has a bounded deadline before any authentication command', { timeout: 10_000 }, async (t) => {
  // A silent owned TCP peer never completes TLS or receives application AUTH.
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => { sockets.add(socket); socket.on('error', () => undefined); });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('silent TLS cleanup deadline')), 2_000);
      silent.close(() => { clearTimeout(timer); resolve(); });
    });
  });
  const address = silent.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(RedisRespClient.connect('rediss://:synthetic-password@127.0.0.1:' + address.port), safeError('REDIS_TIMEOUT'));
});
