import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RedisProviderModule } from '../../../src/saas/runtime/providers.js';
import { AUTH_RATE_LIMIT_SCRIPT, createRedisProvider } from '../../../src/saas/runtime/redis-rate-limit-provider.js';
import { decodeRedisResp2, RedisRespError, type RedisRespValue } from '../../../src/saas/runtime/redis-resp-client.js';

async function fixture(t: TestContext, evalReply: (command: readonly string[], socket: Socket) => void) {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let connections = 0; let failed = false;
  const server = createServer((socket) => {
    connections += 1; sockets.add(socket); socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let input: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      try {
        while (input.length) {
          const parsed = decodeRedisResp2(input); if (parsed === undefined) return;
          assert.ok(Array.isArray(parsed.value));
          const command = parsed.value.map((part: RedisRespValue) => {
            assert.ok(Buffer.isBuffer(part)); return part.toString('utf8');
          });
          input = Buffer.from(input.subarray(parsed.bytes)); commands.push(command);
          if (command[0] === 'PING') socket.write('+PONG\r\n');
          else if (command[0] === 'AUTH' || command[0] === 'SELECT') socket.write('+OK\r\n');
          else { assert.equal(command[0], 'EVAL'); evalReply(command, socket); }
        }
      } catch { failed = true; socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic limiter cleanup deadline')), 2_000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    assert.equal(failed, false, 'synthetic peer must parse actual requests');
  });
  return { url: 'redis://127.0.0.1:' + address.port + '/0', commands, connections: () => connections };
}
function rejection(code: string) {
  return (error: unknown) => error instanceof RedisRespError && error.code === code &&
    error.message === code && error.cause === undefined;
}
const policy = { namespace: 'customer-auth', limit: 10, windowMs: 900_000 } as const;

test('dynamic named module implements the existing loader shape and actual PING readiness', async (t) => {
  const peer = await fixture(t, (_command, socket) => socket.write('*2\r\n:1\r\n:900000\r\n'));
  const module: RedisProviderModule = await import('../../../src/saas/runtime/redis-rate-limit-provider.js');
  const provider = await module.createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  t.after(() => provider.close());
  await provider.checkReady();
  assert.deepEqual(peer.commands, [['PING']]);
  const limiter = await provider.createRateLimiter(policy);
  assert.equal(await limiter.take('synthetic-subject'), undefined);
});

test('denied PTTL rounds UP to positive integer Retry-After seconds, never milliseconds', async (t) => {
  const ttls = [1, 999, 1000, 1001, 900_000];
  const peer = await fixture(t, (_command, socket) => socket.write('*2\r\n:0\r\n:' + ttls.shift() + '\r\n'));
  const provider = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  t.after(() => provider.close());
  const limiter = await provider.createRateLimiter(policy);
  for (const seconds of [1, 1, 1, 2, 900]) {
    const retry = await limiter.take('synthetic-subject');
    assert.equal(retry, seconds); assert.ok(Number.isSafeInteger(retry) && Number(retry) > 0);
  }
});

test('all increments travel in one-key EVAL; namespace/prefix/policy/key hashing is canonical and private', async (t) => {
  const peer = await fixture(t, (_command, socket) => socket.write('*2\r\n:1\r\n:2000\r\n'));
  const provider = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  const alternate = await createRedisProvider({ url: peer.url, keyPrefix: 'another-prefix' });
  t.after(() => provider.close()); t.after(() => alternate.close());
  const key = 'synthetic-user@example.invalid:scope{slot}\r\n';
  const customer = await provider.createRateLimiter({ ...policy, windowMs: 2000 });
  const platform = await provider.createRateLimiter({ ...policy, namespace: 'platform-auth', windowMs: 2000 });
  const otherPolicy = await provider.createRateLimiter({ ...policy, limit: 11, windowMs: 2000 });
  const otherPrefix = await alternate.createRateLimiter({ ...policy, windowMs: 2000 });
  await customer.take(key); await customer.take(key); await platform.take(key);
  await otherPolicy.take(key); await otherPrefix.take(key); await customer.take(key + 'different');
  const requests = peer.commands.filter((command) => command[0] === 'EVAL');
  assert.equal(requests.length, 6);
  const digest = createHash('sha256').update('model-router:auth-rate-limit:v1\0')
    .update('model-router:saas').update('\0').update('customer-auth').update('\0')
    .update('10').update('\0').update('2000').update('\0').update(key).digest('hex');
  assert.equal(requests[0]?.[3], 'model-router:saas:auth-rate-limit:v1:customer-auth:10:2000:' + digest);
  assert.equal(requests[1]?.[3], requests[0]?.[3]);
  assert.equal(new Set([requests[0]?.[3], ...requests.slice(2).map((command) => command[3])]).size, 5);
  for (const request of requests) {
    assert.equal(request.length, 6); assert.equal(request[1], AUTH_RATE_LIMIT_SCRIPT); assert.equal(request[2], '1');
    assert.ok(request[3] && !request[3].includes(key) && !/[{}\r\n@]/.test(request[3]));
  }
});

test('two actual providers share fixed-window server state; rejected requests do not extend TTL', async (t) => {
  // Deliberately synthetic wire semantics, NOT execution/proof of Lua on Redis.
  let now = 100; const state = new Map<string, { count: number; expiry: number }>();
  const peer = await fixture(t, (command, socket) => {
    assert.equal(command[1], AUTH_RATE_LIMIT_SCRIPT); assert.equal(command[2], '1');
    const key = command[3]; assert.ok(key);
    const limit = Number(command[4]); const window = Number(command[5]);
    let row = state.get(key);
    if (row === undefined || row.expiry <= now) { row = { count: 0, expiry: now + window }; state.set(key, row); }
    const allowed = row.count < limit ? 1 : 0;
    if (allowed) row.count += 1;
    socket.write('*2\r\n:' + allowed + '\r\n:' + (row.expiry - now) + '\r\n');
  });
  const a = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  const b = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  t.after(() => a.close()); t.after(() => b.close());
  const first = await a.createRateLimiter({ ...policy, limit: 2, windowMs: 2000 });
  const second = await b.createRateLimiter({ ...policy, limit: 2, windowMs: 2000 });
  const answers = await Promise.all([first.take('subject'), second.take('subject'), first.take('subject')]);
  assert.equal(answers.filter((value) => value === undefined).length, 2);
  assert.equal(answers.filter((value) => value === 2).length, 1);
  now += 1100; assert.equal(await second.take('subject'), 1);
  now += 900; assert.equal(await first.take('subject'), undefined);
});

test('policy primitives are captured immutably and invalid namespaces/options/keys send no EVAL', async (t) => {
  const peer = await fixture(t, (_command, socket) => socket.write('*2\r\n:1\r\n:2000\r\n'));
  const provider = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  t.after(() => provider.close());
  const mutable = { ...policy, limit: 2, windowMs: 2000 };
  const limiter = await provider.createRateLimiter(mutable);
  mutable.limit = 99; mutable.windowMs = 50;
  await limiter.take('subject');
  assert.deepEqual(peer.commands[0]?.slice(4), ['2', '2000']);
  for (const bad of [
    { ...policy, limit: 0 }, { ...policy, limit: 1.5 }, { ...policy, limit: Number.MAX_SAFE_INTEGER },
    { ...policy, windowMs: 0 }, { ...policy, windowMs: 86_400_001 }, { ...policy, windowMs: NaN },
  ]) assert.throws(() => provider.createRateLimiter(bad), rejection('REDIS_INVALID_LIMITER'));
  assert.throws(() => Reflect.apply(provider.createRateLimiter, provider, [{ ...policy, namespace: 'gateway' }]),
    rejection('REDIS_INVALID_LIMITER'));
  for (const key of ['', '\0', 'x'.repeat(4097), '\ud800']) {
    await assert.rejects(limiter.take(key), rejection('REDIS_INVALID_KEY'));
  }
  assert.equal(peer.commands.length, 1);
});

test('invalid prefix/refused extra connection options fail before any dial', async (t) => {
  const peer = await fixture(t, () => assert.fail('invalid options cannot send EVAL'));
  for (const keyPrefix of ['', 'bad{slot}', 'bad space', 'x'.repeat(129)]) {
    await assert.rejects(createRedisProvider({ url: peer.url, keyPrefix }), rejection('REDIS_INVALID_OPTIONS'));
  }
  await assert.rejects(createRedisProvider({ url: peer.url, keyPrefix: 'valid', ...{ rejectUnauthorized: false } }),
    rejection('REDIS_INVALID_OPTIONS'));
  assert.equal(peer.connections(), 0);
});

test('malformed/corrupted limiter replies cannot allow a request and poison the connection', async (t) => {
  for (const reply of ['+OK\r\n', '*1\r\n:1\r\n', '*2\r\n:2\r\n:100\r\n',
    '*2\r\n:1\r\n:-1\r\n', '*2\r\n:0\r\n:0\r\n', '*2\r\n:0\r\n:900001\r\n',
    '*2\r\n:1\r\n$1\r\n1\r\n']) {
    const peer = await fixture(t, (_command, socket) => socket.write(reply));
    const provider = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
    const limiter = await provider.createRateLimiter(policy);
    await assert.rejects(limiter.take('subject'), rejection('REDIS_PROTOCOL_ERROR'));
    await assert.rejects(limiter.take('subject'), rejection('REDIS_PROTOCOL_ERROR'));
    await provider.close(); assert.equal(peer.commands.length, 1); assert.equal(peer.connections(), 1);
  }
});

test('disconnect after EVAL receipt is fail-closed without replay, and close rejects new work', async (t) => {
  let mutations = 0;
  const peer = await fixture(t, (_command, socket) => { mutations += 1; socket.destroy(); });
  const provider = await createRedisProvider({ url: peer.url, keyPrefix: 'model-router:saas' });
  const limiter = await provider.createRateLimiter(policy);
  await assert.rejects(limiter.take('subject'), rejection('REDIS_CONNECTION_FAILED'));
  await assert.rejects(limiter.take('subject'), rejection('REDIS_CONNECTION_FAILED'));
  assert.equal(mutations, 1); assert.equal(peer.connections(), 1);
  const closing = provider.close(); assert.equal(provider.close(), closing); await closing;
  await assert.rejects(limiter.take('subject'), rejection('REDIS_CLOSED'));
  await assert.rejects(async () => await provider.checkReady(), rejection('REDIS_CLOSED'));
  assert.throws(() => provider.createRateLimiter(policy), rejection('REDIS_CLOSED'));
});

test('Lua source contract uses one key and atomic TTL creation, validates damaged state and never slides expiry', () => {
  assert.match(AUTH_RATE_LIMIT_SCRIPT, /redis\.call\("SET", KEYS\[1\], "1", "PX", ARGV\[2\]\)/);
  assert.match(AUTH_RATE_LIMIT_SCRIPT, /ttl < 0 or ttl > window/);
  assert.match(AUTH_RATE_LIMIT_SCRIPT, /count < 1 or count > limit/);
  assert.match(AUTH_RATE_LIMIT_SCRIPT, /tostring\(count\) ~= raw/);
  assert.match(AUTH_RATE_LIMIT_SCRIPT, /if count >= limit then return \{0, ttl\} end/);
  assert.equal((AUTH_RATE_LIMIT_SCRIPT.match(/redis\.call\("SET"/g) ?? []).length, 1);
  assert.doesNotMatch(AUTH_RATE_LIMIT_SCRIPT, /KEYS\[(?!1\])/);
  assert.doesNotMatch(AUTH_RATE_LIMIT_SCRIPT, /EXPIRE|DEL|TIME|EVALSHA|redis\.log/);
  const client = readFileSync(resolve(process.cwd(), 'src/saas/runtime/redis-resp-client.ts'), 'utf8');
  const provider = readFileSync(resolve(process.cwd(), 'src/saas/runtime/redis-rate-limit-provider.ts'), 'utf8');
  assert.match(client, /rejectUnauthorized: true/); assert.match(client, /minVersion: 'TLSv1\.2'/);
  assert.match(client, /socket\.authorized !== true/);
  assert.match(client, /address\.username\?\.fill\(0\); address\.password\?\.fill\(0\);/);
  assert.match(client, /this\.buffer\.fill\(0\); this\.buffer = Buffer\.alloc\(0\);/);
  assert.match(client, /item\.frame\.fill\(0\)/);
  assert.doesNotMatch(client + provider, /process\.env|console\.|EVALSHA|createRequire|child_process/);
  assert.match(provider, /Math\.ceil\(ttl \/ 1_000\)/);
});
