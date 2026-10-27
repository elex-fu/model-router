import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AbortError, SimpleError, SocketClosedUnexpectedlyError, TimeoutError } from '@redis/client';
import {
  createRedisFastGatewayAdmission,
  type RedisEvalClient,
} from '../../../../src/saas/gateway/fast/redis-admission.js';
import { createRedisScriptTransport } from '../../../../src/saas/gateway/fast/redis-script-transport.js';

const scripts = ["return redis.call('GET',KEYS[1])", "return redis.call('INCRBY',KEYS[1],ARGV[1])"];
const sha = (script: string) => createHash('sha1').update(script).digest('hex');
const noScript = () => new SimpleError('NOSCRIPT No matching script. Please use EVAL.');
const input = () => ({ keys: ['{test}:one'], arguments: ['7'] });

test('cache hits send only the exact static digest with unmodified inputs and replies', async () => {
  const calls: unknown[][] = [];
  const reply = { untouched: true };
  const redis = createRedisScriptTransport(
    () => ({
      evalSha: async (...args) => {
        calls.push(args);
        return reply;
      },
      eval: async () => assert.fail('cache hits must not resend the body'),
    }),
    scripts,
  );
  for (const script of scripts) {
    const options = input();
    assert.equal(await redis.eval(script, options), reply);
    assert.deepEqual(calls.at(-1), [sha(script), options]);
    assert.equal(calls.at(-1)?.[1], options);
  }
  assert.equal(calls.length, scripts.length);
});

test('a genuine NOSCRIPT falls back once with the same command deadline, body, keys and arguments', async () => {
  const calls: unknown[][] = [];
  let commands = 0;
  const options = input();
  const redis = createRedisScriptTransport(() => {
    commands++;
    return {
      evalSha: async (...args) => {
        calls.push(['EVALSHA', ...args]);
        throw noScript();
      },
      eval: async (...args) => {
        calls.push(['EVAL', ...args]);
        return 'ack';
      },
    };
  }, scripts);
  assert.equal(await redis.eval(scripts[0], options), 'ack');
  assert.equal(commands, 1, 'the fallback must not allocate a fresh command/deadline');
  assert.deepEqual(calls, [
    ['EVALSHA', sha(scripts[0]), options],
    ['EVAL', scripts[0], options],
  ]);
  assert.equal(calls[0][2], options);
  assert.equal(calls[1][2], options);
});

test('unknown ACKs, timeouts, runtime/ACL errors and lookalike NOSCRIPT errors never trigger a retry', async () => {
  const errors = [
    new AbortError(),
    new TimeoutError(),
    new SocketClosedUnexpectedlyError(),
    new Error('unknown ACK after execution'),
    new Error(noScript().message),
    { message: noScript().message },
    new SimpleError('NOPERM this user has no permissions to run the evalsha command'),
    new SimpleError('ERR Error running script: NOSCRIPT'),
    new SimpleError('NOSCRIPT unexpected response'),
  ];
  for (const error of errors) {
    let attempts = 0;
    const redis = createRedisScriptTransport(
      () => ({
        evalSha: async () => {
          attempts++;
          throw error;
        },
        eval: async () => assert.fail('only the canonical decoded NOSCRIPT may fall back'),
      }),
      scripts,
    );
    await assert.rejects(redis.eval(scripts[0], input()), (actual) => actual === error);
    assert.equal(attempts, 1);
  }
});

test('fallback errors including lost ACKs and a second NOSCRIPT propagate without replay', async () => {
  for (const error of [new AbortError(), new Error('lost EVAL ACK'), noScript()]) {
    const calls: string[] = [];
    const redis = createRedisScriptTransport(
      () => ({
        evalSha: async () => {
          calls.push('EVALSHA');
          throw noScript();
        },
        eval: async () => {
          calls.push('EVAL');
          throw error;
        },
      }),
      scripts,
    );
    await assert.rejects(redis.eval(scripts[0], input()), (actual) => actual === error);
    assert.deepEqual(calls, ['EVALSHA', 'EVAL']);
  }
});

test('cold concurrent calls retain independent commands, inputs and replies without replay', async () => {
  const calls: unknown[][] = [];
  let commands = 0;
  const redis = createRedisScriptTransport(() => {
    const commandId = commands++;
    return {
      evalSha: async (digest, options) => {
        calls.push([commandId, 'EVALSHA', digest, options]);
        throw noScript();
      },
      eval: async (script, options) => {
        calls.push([commandId, 'EVAL', script, options]);
        return options.arguments[0];
      },
    };
  }, scripts);
  const requests = Array.from({ length: 20 }, (_, index) => ({
    keys: [`{test}:${index}`],
    arguments: [String(index)],
  }));
  const replies = await Promise.all(requests.map((options) => redis.eval(scripts[1], options)));
  assert.deepEqual(
    replies,
    requests.map((options) => options.arguments[0]),
  );
  assert.equal(commands, requests.length);
  for (const [index, options] of requests.entries()) {
    const own = calls.filter(([commandId]) => commandId === index);
    assert.deepEqual(own, [
      [index, 'EVALSHA', sha(scripts[1]), options],
      [index, 'EVAL', scripts[1], options],
    ]);
    assert.equal(own[0][3], options);
    assert.equal(own[1][3], options);
  }
});

test('an elapsed original deadline is not refreshed for a cold fallback', async () => {
  const controller = new AbortController();
  let commands = 0;
  let fallbackAttempts = 0;
  const redis = createRedisScriptTransport(() => {
    commands++;
    const signal = controller.signal;
    return {
      evalSha: async () => {
        controller.abort();
        throw noScript();
      },
      eval: async () => {
        fallbackAttempts++;
        signal.throwIfAborted();
        assert.fail('an expired facade must not execute a fallback');
      },
    };
  }, scripts);
  await assert.rejects(redis.eval(scripts[0], input()), (error) => error === controller.signal.reason);
  assert.equal(commands, 1);
  assert.equal(fallbackAttempts, 1);
});

test('unregistered bodies cannot expand the bounded static script set or issue commands', async () => {
  const redis = createRedisScriptTransport(() => assert.fail('must reject before constructing a command'), scripts);
  await assert.rejects(redis.eval('return 1', input()), /Unknown fast admission Redis script/);
});

test('transport optimization preserves all five Lua identities, including shared split release body', async () => {
  const seen: { sha: string; bytes: number }[] = [];
  const redis: RedisEvalClient = {
    eval: async (script, options) => {
      seen.push({ sha: sha(script), bytes: Buffer.byteLength(script) });
      const p = JSON.parse(options.arguments[0].startsWith('{') ? options.arguments[0] : '{}');
      return JSON.stringify({
        ok: true,
        readyInMs: 0,
        token: p.token,
        incarnation: p.incarnation,
        bucket: '123',
        renewInMs: 750,
      });
    },
  };
  const service = createRedisFastGatewayAdmission({
    redis,
    namespace: 'identity',
    runId: 'identity',
    maxTtlMs: 1000,
    renewIntervalMs: 300,
  });
  await service.initialize({ drained: true });
  assert.equal(await service.checkReady(), true);
  const result = await service.acquire({
    requestId: 'request',
    tenantId: 'tenant',
    projectId: 'project',
    proxyKeyId: 'key',
    accountId: 'account',
    accountOwnerScope: 'platform',
    tokenUnits: 1,
    ttlMs: 1000,
    limits: {},
  });
  assert.ok(result.allowed);
  await result.lease.renew();
  assert.ok(result.lease.releaseConcurrency && result.lease.reconcileDurableUsage);
  await result.lease.releaseConcurrency();
  await result.lease.reconcileDurableUsage(1);
  await result.lease.release();
  const release = { sha: 'e2376b74652e2c38027eaafee88fd3f6443363dd', bytes: 6461 };
  assert.deepEqual(seen, [
    { sha: '6f941e8e4c1243df508434ef4989e3ac51a966b9', bytes: 564 },
    { sha: 'a3fecfcadc58907f62cda8e834a5e0243edbfb46', bytes: 355 },
    { sha: 'd39e166d0878ccc0e77d89f91802a1fe7787f545', bytes: 4477 },
    { sha: 'd8c1c1e747e8a4d044ae06392c6aba38284c1bba', bytes: 1995 },
    release,
    release,
    release,
  ]);
});
