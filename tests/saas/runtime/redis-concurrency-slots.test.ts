import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  computeStickySessionHash,
  createRedisConcurrencySlots,
  createRedisRuntimeCache,
  REDIS_CACHE_GET_SCRIPT,
  REDIS_CACHE_SET_SCRIPT,
  REDIS_SLOT_RELEASE_SCRIPT,
  REDIS_SLOT_SCRIPT,
  redisSlotKey,
  redisStickyKey,
  stickyKeyForRequest,
  tokenCacheKeyForEnvelope,
} from '../../../src/saas/runtime/redis-concurrency-slots.js';
import { createRedisProvider } from '../../../src/saas/runtime/redis-rate-limit-provider.js';
import { decodeRedisResp2, RedisRespClient, type RedisRespValue } from '../../../src/saas/runtime/redis-resp-client.js';

async function fixture(t: TestContext, evalReply: (command: readonly string[], socket: Socket) => void) {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let failed = false;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let input: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      try {
        while (input.length) {
          const parsed = decodeRedisResp2(input);
          if (parsed === undefined) return;
          assert.ok(Array.isArray(parsed.value));
          const command = parsed.value.map((part: RedisRespValue) => {
            assert.ok(Buffer.isBuffer(part));
            return part.toString('utf8');
          });
          input = Buffer.from(input.subarray(parsed.bytes));
          commands.push(command);
          if (command[0] === 'PING') socket.write('+PONG\r\n');
          else if (command[0] === 'AUTH' || command[0] === 'SELECT') socket.write('+OK\r\n');
          else {
            assert.equal(command[0], 'EVAL');
            evalReply(command, socket);
          }
        }
      } catch {
        failed = true;
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic slot cleanup deadline')), 2_000);
      server.close(() => {
        clearTimeout(timer);
        resolveClose();
      });
    });
    assert.equal(failed, false, 'synthetic peer must parse actual requests');
  });
  return { url: `redis://127.0.0.1:${address.port}/0`, commands, connections: () => connections };
}

/**
 * A semantic fake of the slot ZSET: it interprets the ARGV of the acquire
 * script and emulates member/score/window/gate semantics against a mutable
 * server clock, so the client's marshaling and the sub2api semantics are
 * exercised together. (Real Lua execution is the opt-in local integration
 * harness's job, mirroring the rate-limit suite.)
 */
function slotStateFake() {
  let now = 10_000;
  const zsets = new Map<string, Map<string, number>>();
  return {
    advance: (ms: number) => {
      now += ms;
    },
    reply: (command: readonly string[], socket: Socket): void => {
      if (command[1] === REDIS_SLOT_RELEASE_SCRIPT) {
        const key = command[3] ?? '';
        zsets.get(key)?.delete(command[4] ?? '');
        socket.write(':1\r\n');
        return;
      }
      assert.equal(command[1], REDIS_SLOT_SCRIPT);
      const key = command[3] ?? '';
      const member = command[4] ?? '';
      const max = Number(command[5]);
      const window = Number(command[6]);
      let zset = zsets.get(key);
      if (zset === undefined) {
        zset = new Map();
        zsets.set(key, zset);
      }
      for (const [existing, score] of zset) {
        if (score < now - window) zset.delete(existing);
      }
      const exists = zset.has(member);
      if (!exists && zset.size >= max) {
        socket.write(`*2\r\n:0\r\n:${now}\r\n`);
        return;
      }
      zset.set(member, now);
      socket.write(`*2\r\n:1\r\n:${now}\r\n`);
    },
  };
}

const PREFIX = 'model-router:saas';

test('acquire travels in one-key EVAL with the request id as member and a digested account key', async (t) => {
  const peer = await fixture(t, (_command, socket) => socket.write('*2\r\n:1\r\n:20000\r\n'));
  const client = await RedisRespClient.connect(peer.url);
  t.after(() => client.close());
  const slots = createRedisConcurrencySlots(client, { keyPrefix: PREFIX });
  const decision = await slots.tryAcquire({
    ownerScopeKey: 'platform',
    accountId: 'acct-raw-id',
    requestId: 'req-1',
    maxSlots: 5,
    windowMs: 120_000,
  });
  assert.deepEqual(decision, { state: 'acquired' });
  const request = peer.commands.find((command) => command[0] === 'EVAL');
  assert.ok(request);
  assert.equal(request[1], REDIS_SLOT_SCRIPT);
  assert.equal(request[2], '1');
  const digest = createHash('sha256')
    .update('model-router:slot:acct:v1')
    .update('\0')
    .update('platform')
    .update('\0')
    .update('acct-raw-id')
    .digest('hex');
  const expectedKey = redisSlotKey(PREFIX, 'platform', 'acct-raw-id');
  assert.ok(expectedKey);
  assert.equal(request[3], expectedKey);
  assert.equal(request[3], `${PREFIX}:concurrency-slot:v1:acct:${digest}`);
  assert.ok(request[3] && !request[3].includes('acct-raw-id'));
  assert.deepEqual(request.slice(4), ['req-1', '5', '120000', '600000']);
});

test('slot gate, idempotent refresh and lazy window eviction follow the sub2api semantics', async (t) => {
  const fake = slotStateFake();
  const peer = await fixture(t, fake.reply);
  const a = await RedisRespClient.connect(peer.url);
  const b = await RedisRespClient.connect(peer.url);
  t.after(() => a.close());
  t.after(() => b.close());
  const first = createRedisConcurrencySlots(a, { keyPrefix: PREFIX });
  const second = createRedisConcurrencySlots(b, { keyPrefix: PREFIX });
  const input = { ownerScopeKey: 'tenant-1', accountId: 'acct', maxSlots: 2, windowMs: 1_000 };
  assert.deepEqual(await first.tryAcquire({ ...input, requestId: 'r1' }), { state: 'acquired' });
  assert.deepEqual(await second.tryAcquire({ ...input, requestId: 'r2' }), { state: 'acquired' });
  // Full: a third distinct request is saturated.
  assert.deepEqual(await first.tryAcquire({ ...input, requestId: 'r3' }), { state: 'saturated' });
  // Idempotent retry: an existing member refreshes its score and passes the gate.
  assert.deepEqual(await second.tryAcquire({ ...input, requestId: 'r1' }), { state: 'acquired' });
  // Release frees the slot.
  await first.release({ ...input, requestId: 'r2' });
  assert.deepEqual(await first.tryAcquire({ ...input, requestId: 'r3' }), { state: 'acquired' });
  // Lazy eviction: an unreleased member older than the window stops counting.
  fake.advance(1_500);
  assert.deepEqual(await second.tryAcquire({ ...input, requestId: 'r4' }), { state: 'acquired' });
  assert.deepEqual(await second.tryAcquire({ ...input, requestId: 'r5' }), { state: 'acquired' });
  assert.deepEqual(await second.tryAcquire({ ...input, requestId: 'r6' }), { state: 'saturated' });
});

test('malformed replies and disconnects fail OPEN to unavailable and release never throws', async (t) => {
  for (const reply of ['+OK\r\n', '*1\r\n:1\r\n', '*2\r\n:2\r\n:100\r\n', '*2\r\n:1\r\n$1\r\n1\r\n']) {
    const peer = await fixture(t, (_command, socket) => socket.write(reply));
    const client = await RedisRespClient.connect(peer.url);
    const slots = createRedisConcurrencySlots(client, { keyPrefix: PREFIX });
    assert.deepEqual(
      await slots.tryAcquire({
        ownerScopeKey: 'platform',
        accountId: 'a',
        requestId: 'r',
        maxSlots: 1,
        windowMs: 60_000,
      }),
      { state: 'unavailable' },
    );
    await slots.release({ ownerScopeKey: 'platform', accountId: 'a', requestId: 'r' });
    await client.close();
  }
  const peer = await fixture(t, (_command, socket) => socket.destroy());
  const client = await RedisRespClient.connect(peer.url);
  const slots = createRedisConcurrencySlots(client, { keyPrefix: PREFIX });
  assert.deepEqual(
    await slots.tryAcquire({
      ownerScopeKey: 'platform',
      accountId: 'a',
      requestId: 'r',
      maxSlots: 1,
      windowMs: 60_000,
    }),
    { state: 'unavailable' },
  );
  await slots.release({ ownerScopeKey: 'platform', accountId: 'a', requestId: 'r' });
  await client.close();
});

test('malformed slot input degrades to saturated (shape) and never sends EVAL', async (t) => {
  const peer = await fixture(t, () => assert.fail('invalid input cannot send EVAL'));
  const client = await RedisRespClient.connect(peer.url);
  t.after(() => client.close());
  const slots = createRedisConcurrencySlots(client, { keyPrefix: PREFIX });
  for (const bad of [
    { ownerScopeKey: '', accountId: 'a', requestId: 'r', maxSlots: 1, windowMs: 60_000 },
    { ownerScopeKey: 'platform', accountId: '', requestId: 'r', maxSlots: 1, windowMs: 60_000 },
    { ownerScopeKey: 'platform', accountId: 'a', requestId: '', maxSlots: 1, windowMs: 60_000 },
    { ownerScopeKey: 'platform', accountId: 'a', requestId: 'r', maxSlots: 0, windowMs: 60_000 },
    { ownerScopeKey: 'platform', accountId: 'a', requestId: 'r', maxSlots: 1, windowMs: 500 },
  ]) {
    assert.deepEqual(await slots.tryAcquire(bad), { state: 'saturated' });
  }
  assert.equal(peer.commands.length, 0);
});

test('runtime cache get/set round-trips base64 values with a PX TTL and fails open', async (t) => {
  const stored = new Map<string, { value: string; ttl: number }>();
  const peer = await fixture(t, (command, socket) => {
    if (command[1] === REDIS_CACHE_GET_SCRIPT) {
      const entry = stored.get(command[3] ?? '');
      if (entry === undefined) socket.write('$-1\r\n');
      else socket.write(`$${Buffer.byteLength(entry.value)}\r\n${entry.value}\r\n`);
      return;
    }
    assert.equal(command[1], REDIS_CACHE_SET_SCRIPT);
    stored.set(command[3] ?? '', { value: command[4] ?? '', ttl: Number(command[5]) });
    socket.write(':1\r\n');
  });
  const client = await RedisRespClient.connect(peer.url);
  t.after(() => client.close());
  const cache = createRedisRuntimeCache(client, { keyPrefix: PREFIX });
  assert.deepEqual(await cache.get('model-router:saas:sticky:v1:abc'), { state: 'miss', value: null });
  const secret = Buffer.from('probe-secret-material');
  await cache.set('model-router:saas:sticky:v1:abc', secret, 60_000);
  const setCommand = peer.commands.find((command) => command[1] === REDIS_CACHE_SET_SCRIPT);
  assert.ok(setCommand);
  assert.equal(setCommand[2], '1');
  assert.equal(setCommand[3], 'model-router:saas:sticky:v1:abc');
  assert.equal(setCommand[4], secret.toString('base64'));
  assert.equal(setCommand[5], '60000');
  const hit = await cache.get('model-router:saas:sticky:v1:abc');
  assert.equal(hit.state, 'hit');
  assert.ok(Buffer.isBuffer(hit.value));
  assert.equal(hit.value?.toString('utf8'), 'probe-secret-material');
  // A hit materializes a FRESH buffer every time (zeroization safety).
  const again = await cache.get('model-router:saas:sticky:v1:abc');
  assert.notEqual(again.value, hit.value);
  // Best-effort set: malformed key/value and disconnects never throw.
  await cache.set('', secret, 60_000);
  await cache.set('model-router:saas:sticky:v1:abc', Buffer.alloc(0), 60_000);
  await cache.set('model-router:saas:sticky:v1:abc', secret, 0);
});

test('runtime cache disconnect fails open to unavailable', async (t) => {
  const peer = await fixture(t, (_command, socket) => socket.destroy());
  const client = await RedisRespClient.connect(peer.url);
  t.after(() => client.close());
  const cache = createRedisRuntimeCache(client, { keyPrefix: PREFIX });
  assert.deepEqual(await cache.get('any-key'), { state: 'unavailable', value: null });
});

test('sticky sessionHash priority follows session-id, conversation_id, prompt_cache_key, content hash', () => {
  assert.equal(
    computeStickySessionHash({
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      promptCacheKey: 'cache-key-1',
      contentHash: 'hash-1',
    }),
    'session-1',
  );
  assert.equal(
    computeStickySessionHash({ conversationId: 'conversation-1', promptCacheKey: 'cache-key-1' }),
    'conversation-1',
  );
  assert.equal(computeStickySessionHash({ promptCacheKey: 'cache-key-1', contentHash: 'hash-1' }), 'cache-key-1');
  assert.equal(computeStickySessionHash({ contentHash: 'hash-1' }), 'hash-1');
  assert.equal(computeStickySessionHash({}), null);
  assert.equal(computeStickySessionHash({ sessionId: '', conversationId: 'conversation-1' }), 'conversation-1');
  for (const bad of ['', '\0', 'x'.repeat(513)]) {
    assert.equal(computeStickySessionHash({ sessionId: bad, contentHash: 'hash-1' }), 'hash-1');
  }
  // The sticky key digests the pool scope and the chosen reference.
  const key = stickyKeyForRequest(PREFIX, 'pool-scope', { sessionId: 'session-1' });
  assert.ok(key);
  assert.ok(key.startsWith(`${PREFIX}:sticky:v1:`));
  assert.ok(!key.includes('pool-scope') && !key.includes('session-1'));
  assert.equal(key, redisStickyKey(PREFIX, 'pool-scope', 'session-1'));
  assert.equal(stickyKeyForRequest(PREFIX, 'pool-scope', {}), null);
});

test('token cache keys change with the sealed envelope material (rotation misses by construction)', () => {
  const envelope = {
    kmsKeyId: 'kms-key-1',
    wrappedDek: 'wrapped-dek',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
    authTag: 'auth-tag',
  };
  const key = tokenCacheKeyForEnvelope(PREFIX, envelope);
  assert.ok(key);
  assert.ok(key.startsWith(`${PREFIX}:token-cache:v1:`));
  assert.ok(!key.includes('ciphertext'));
  assert.notEqual(tokenCacheKeyForEnvelope(PREFIX, { ...envelope, ciphertext: 'rotated' }), key);
  assert.notEqual(tokenCacheKeyForEnvelope(PREFIX, { ...envelope, nonce: 'rotated' }), key);
  assert.equal(tokenCacheKeyForEnvelope(PREFIX, envelope), key);
});

test('the provider exposes slot and cache clients over the same connection', async (t) => {
  const peer = await fixture(t, (command, socket) => {
    if (command[1] === REDIS_CACHE_GET_SCRIPT) socket.write('$-1\r\n');
    else if (command[1] === REDIS_CACHE_SET_SCRIPT) socket.write(':1\r\n');
    else if (command[1] === REDIS_SLOT_RELEASE_SCRIPT) socket.write(':1\r\n');
    else socket.write('*2\r\n:1\r\n:20000\r\n');
  });
  const provider = await createRedisProvider({ url: peer.url, keyPrefix: PREFIX });
  t.after(() => provider.close());
  await provider.checkReady();
  const slots = await provider.createSlotClient();
  const cache = await provider.createCacheClient();
  assert.deepEqual(
    await slots.tryAcquire({
      ownerScopeKey: 'platform',
      accountId: 'a',
      requestId: 'r',
      maxSlots: 1,
      windowMs: 60_000,
    }),
    { state: 'acquired' },
  );
  await slots.release({ ownerScopeKey: 'platform', accountId: 'a', requestId: 'r' });
  assert.deepEqual(await cache.get(`${PREFIX}:sticky:v1:x`), { state: 'miss', value: null });
  await cache.set(`${PREFIX}:sticky:v1:x`, Buffer.from('account-id'), 3_600_000);
  // One connection serves the readiness ping and every hot-state command.
  assert.equal(peer.connections(), 1);
  assert.ok(peer.commands.length >= 4);
});

test('Lua source contract: one key, server TIME scores, lazy eviction, refresh-on-exists, ZCARD gate, PEXPIRE', () => {
  assert.match(REDIS_SLOT_SCRIPT, /local t = redis\.call\("TIME"\)/);
  assert.match(REDIS_SLOT_SCRIPT, /ZREMRANGEBYSCORE", KEYS\[1\], "-inf", now - window/);
  assert.match(REDIS_SLOT_SCRIPT, /local exists = redis\.call\("ZSCORE", KEYS\[1\], member\)/);
  assert.match(REDIS_SLOT_SCRIPT, /if \(not exists\) and redis\.call\("ZCARD", KEYS\[1\]\) >= max then/);
  assert.match(REDIS_SLOT_SCRIPT, /redis\.call\("ZADD", KEYS\[1\], now, member\)/);
  assert.match(REDIS_SLOT_SCRIPT, /redis\.call\("PEXPIRE", KEYS\[1\], ttl\)/);
  assert.doesNotMatch(REDIS_SLOT_SCRIPT, /KEYS\[(?!1\])/);
  assert.doesNotMatch(REDIS_SLOT_SCRIPT, /EVALSHA|redis\.log/);
  assert.match(REDIS_SLOT_RELEASE_SCRIPT, /redis\.call\("ZREM", KEYS\[1\], ARGV\[1\]\)/);
  assert.doesNotMatch(REDIS_SLOT_RELEASE_SCRIPT, /KEYS\[(?!1\])/);
  const source = readFileSync(resolve(process.cwd(), 'src/saas/runtime/redis-concurrency-slots.ts'), 'utf8');
  const client = readFileSync(resolve(process.cwd(), 'src/saas/runtime/redis-resp-client.ts'), 'utf8');
  assert.doesNotMatch(source + client, /process\.env|console\.|createRequire|child_process/);
  // Red line documentation: the module states the PG-authoritative, fail-open role.
  assert.match(source, /PostgreSQL stays authoritative/);
  assert.match(source, /fail-open/);
});
