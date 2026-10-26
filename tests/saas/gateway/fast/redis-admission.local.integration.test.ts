import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createClient } from '@redis/client';
import {
  createRedisFastGatewayAdmission,
  type FastAdmissionInput,
  type FastAdmissionResult,
  openRedisFastGatewayAdmission,
} from '../../../../src/saas/gateway/fast/redis-admission.js';

const enabled = process.env.MODEL_ROUTER_FAST_ADMISSION_REDIS_TEST === '1';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function admitted(value: FastAdmissionResult) {
  assert.equal(value.allowed, true, JSON.stringify(value));
  if (!value.allowed) throw new Error('Expected admitted lease');
  return value.lease;
}
function input(change: Partial<FastAdmissionInput> = {}): FastAdmissionInput {
  return {
    requestId: randomUUID(),
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    accountOwnerScope: 'platform',
    accountId: 'account-a',
    tokenUnits: 7,
    ttlMs: 2000,
    limits: { tenant: { concurrency: 3 }, account: { concurrency: 2 } },
    ...change,
  };
}
async function fixture(t: TestContext) {
  const binary = process.env.MODEL_ROUTER_TEST_REDIS_BIN;
  assert.ok(binary && existsSync(binary), 'MODEL_ROUTER_TEST_REDIS_BIN must select an owned local Redis executable');
  const directory = mkdtempSync(join(tmpdir(), 'mr-fast-admission-'));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const args = [
    '--bind',
    '127.0.0.1',
    '--port',
    String(port),
    '--save',
    '',
    '--appendonly',
    'no',
    '--maxmemory-policy',
    'noeviction',
    '--dir',
    directory,
  ];
  const start = async () => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Owned Redis readiness timed out')), 5000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Owned Redis exited before readiness'));
      });
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('Ready to accept connections')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return child;
  };
  let child = await start();
  const url = `redis://127.0.0.1:${port}`;
  const inspector = createClient({ url, socket: { reconnectStrategy: false } });
  inspector.on('error', () => {});
  await inspector.connect();
  const clients: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (inspector.isOpen) inspector.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const options = { url, maxTtlMs: 5000, abortGraceMs: 100, renewIntervalMs: 50, drained: true };
  const open = async (namespace = randomUUID(), change: Partial<typeof options> = {}) => {
    const client = await openRedisFastGatewayAdmission({ ...options, ...change, namespace });
    clients.push(client);
    return client;
  };
  return {
    inspector,
    url,
    open,
    restart: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = await start();
    },
  };
}

test('real Redis authoritative fast admission', { skip: !enabled, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await t.test(
    'one command admits, monotonic assertion is local, release is idempotent and does not refund RPM',
    async () => {
      const info = await f.inspector.info('server');
      const runId = /^run_id:(\w+)\r?$/m.exec(info)?.[1];
      assert.ok(runId);
      let calls = 0;
      const service = createRedisFastGatewayAdmission({
        redis: {
          eval: async (script, options) => {
            calls++;
            return f.inspector.eval(script, options);
          },
        },
        namespace: randomUUID(),
        runId,
        maxTtlMs: 5000,
        renewIntervalMs: 50,
      });
      await service.initialize({ drained: true });
      calls = 0;
      const request = input({ limits: { tenant: { rpm: 1, concurrency: 1 } } });
      const lease = admitted(await service.acquire(request));
      assert.equal(calls, 1);
      assert.equal(await lease.assertValid(), true);
      assert.equal(calls, 1);
      await lease.release();
      await lease.release();
      assert.equal(calls, 2);
      assert.equal(await lease.assertValid(), false);
      assert.deepEqual(await service.acquire(input({ limits: request.limits })), {
        allowed: false,
        reason: 'rate_limited',
      });
    },
  );
  await t.test('simultaneous multi-instance requests never exceed global platform account capacity', async () => {
    const namespace = randomUUID();
    const services = [await f.open(namespace), await f.open(namespace)];
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        (services[index % 2] as (typeof services)[number]).acquire(
          input({ tenantId: `tenant-${index}`, limits: { account: { concurrency: 5 } } }),
        ),
      ),
    );
    const leases = results.filter((result) => result.allowed).map(admitted);
    assert.equal(leases.length, 5);
    await Promise.all(leases.map((lease) => lease.release()));
    admitted(
      await (services[0] as (typeof services)[number]).acquire(input({ limits: { account: { concurrency: 5 } } })),
    );
  });
  await t.test(
    'tenant, project, key, user and private account scopes isolate tenants; billing group is global',
    async () => {
      const service = await f.open();
      const limits = {
        tenant: { concurrency: 1 },
        project: { concurrency: 1 },
        key: { concurrency: 1 },
        user: { concurrency: 1 },
        account: { concurrency: 1 },
      };
      const a = admitted(await service.acquire(input({ accountOwnerScope: 'tenant-a', userId: 'same-user', limits })));
      const b = admitted(
        await service.acquire(
          input({ tenantId: 'tenant-b', accountOwnerScope: 'tenant-b', userId: 'same-user', limits }),
        ),
      );
      assert.equal((await service.acquire(input({ accountOwnerScope: 'tenant-b', limits }))).allowed, false);
      await a.release();
      await b.release();
      admitted(await service.acquire(input({ groupId: 'shared-group', limits: { group: { rpm: 1 } } })));
      assert.equal(
        (await service.acquire(input({ tenantId: 'tenant-b', groupId: 'shared-group', limits: { group: { rpm: 1 } } })))
          .allowed,
        false,
      );
    },
  );
  await t.test('every individual dimension gates, TPM rejects without consuming other dimensions', async () => {
    for (const dimension of ['tenant', 'project', 'key', 'user', 'group', 'account'] as const) {
      const service = await f.open();
      const request = input({ userId: 'user-a', groupId: 'group-a', limits: { [dimension]: { concurrency: 1 } } });
      const lease = admitted(await service.acquire(request));
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false, dimension);
      await lease.release();
      admitted(await service.acquire({ ...request, requestId: randomUUID() }));
    }
    const service = await f.open();
    const limits = { tenant: { rpm: 1 }, account: { tpm: 5 } };
    assert.deepEqual(await service.acquire(input({ limits })), { allowed: false, reason: 'quota_exceeded' });
    admitted(await service.acquire(input({ limits, tokenUnits: 4 })));
  });
  await t.test('durable actual usage reconciles TPM once but never refunds RPM or unknown usage', async () => {
    const service = await f.open();
    const limits = { tenant: { tpm: 100 }, account: { tpm: 100, concurrency: 2 } };
    const first = admitted(await service.acquire(input({ tokenUnits: 90, limits })));
    assert.equal((await service.acquire(input({ tokenUnits: 20, limits }))).allowed, false);
    await first.release({ outcome: 'success', actualTokenUnits: 10 });
    await first.release({ outcome: 'success', actualTokenUnits: 0 });
    admitted(await service.acquire(input({ tokenUnits: 90, limits })));
    assert.equal((await service.acquire(input({ tokenUnits: 1, limits }))).allowed, false);
    const unknown = await f.open();
    const unresolved = admitted(await unknown.acquire(input({ tokenUnits: 90, limits })));
    await unresolved.release({ outcome: 'success' });
    assert.equal((await unknown.acquire(input({ tokenUnits: 20, limits }))).allowed, false);
    const rpm = await f.open();
    const rpmLimits = { account: { rpm: 1, tpm: 100 } };
    await admitted(await rpm.acquire(input({ tokenUnits: 90, limits: rpmLimits }))).release({
      outcome: 'success',
      actualTokenUnits: 0,
    });
    assert.equal((await rpm.acquire(input({ tokenUnits: 1, limits: rpmLimits }))).allowed, false);
  });
  await t.test('real server-clock rollover reconciles only the immutable admission bucket', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    const limits = { account: { tpm: 200 } };
    const request = input({ tokenUnits: 90, ttlMs: 5000, limits });
    const first = admitted(await service.acquire(request));
    const foreign = await f.open(namespace);
    assert.equal((await foreign.acquire(request)).allowed, false);
    const tag = createHash('sha256')
      .update(JSON.stringify([namespace]))
      .digest('hex');
    const [leaseKey] = await f.inspector.keys(`mr:fast:{${tag}}:lease:*`);
    const original = JSON.parse((await f.inspector.get(leaseKey))!);
    for (;;) {
      const clock = (await f.inspector.sendCommand(['TIME'])) as string[];
      if (Number(clock[0]) > Number(original.bucket)) break;
      await delay(10);
    }
    admitted(await service.acquire(input({ tokenUnits: 90, ttlMs: 5000, limits })));
    await first.release({ outcome: 'success', actualTokenUnits: 10 });
    const [rateKey] = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
    const rate = JSON.parse((await f.inspector.get(rateKey))!);
    assert.equal(rate.buckets[original.bucket][1], 10);
    const newer = Object.entries(rate.buckets).filter(([bucket]) => bucket !== original.bucket);
    assert.equal(newer.length, 1);
    assert.equal((newer[0][1] as number[])[1], 90);
    admitted(await service.acquire(input({ tokenUnits: 100, ttlMs: 5000, limits })));
  });
  await t.test('a pruned original bucket never refunds a newer bucket', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits: { account: { tpm: 100 } } })));
    const tag = createHash('sha256')
      .update(JSON.stringify([namespace]))
      .digest('hex');
    const [leaseKey] = await f.inspector.keys(`mr:fast:{${tag}}:lease:*`);
    const receipt = JSON.parse((await f.inspector.get(leaseKey))!);
    const [rateKey] = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
    const newerBucket = String(Number(receipt.bucket) + 1);
    const replacement = { buckets: { [newerBucket]: [1, 30] } };
    await f.inspector.set(rateKey, JSON.stringify(replacement), { PX: 61000 });
    await lease.release({ outcome: 'success', actualTokenUnits: 1 });
    assert.deepEqual(JSON.parse((await f.inspector.get(rateKey))!), replacement);
  });
  await t.test('atomic TPM reconciliation survives denied MSET and post-MSET expiry errors', async () => {
    const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
    assert.ok(runId);
    for (const denied of ['mset', 'pexpireat']) {
      const namespace = randomUUID();
      await f.open(namespace);
      const username = `quota-${randomUUID()}`;
      const password = randomUUID();
      await f.inspector.sendCommand(['ACL', 'SETUSER', username, 'reset', 'on', `>${password}`, '~mr:fast:*', '+@all']);
      const client = createClient({ url: f.url, username, password, socket: { reconnectStrategy: false } });
      client.on('error', () => {});
      await client.connect();
      try {
        const service = createRedisFastGatewayAdmission({
          redis: client,
          namespace,
          runId,
          maxTtlMs: 5000,
          abortGraceMs: 100,
          renewIntervalMs: 50,
        });
        const lease = admitted(
          await service.acquire(input({ tokenUnits: 90, limits: { tenant: { tpm: 100 }, account: { tpm: 100 } } })),
        );
        const tag = createHash('sha256')
          .update(JSON.stringify([namespace]))
          .digest('hex');
        const keys = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
        assert.equal(keys.length, 2);
        const totals = async () =>
          Promise.all(
            keys.map(async (key) =>
              Object.values(JSON.parse((await f.inspector.get(key))!).buckets as Record<string, number[]>).reduce(
                (total, counts) => total + counts[1],
                0,
              ),
            ),
          );
        await f.inspector.sendCommand(['ACL', 'SETUSER', username, `-${denied}`]);
        await assert.rejects(lease.release({ outcome: 'success', actualTokenUnits: 10 }), /release unavailable/);
        assert.deepEqual(await totals(), denied === 'mset' ? [90, 90] : [10, 10]);
        await f.inspector.sendCommand(['ACL', 'SETUSER', username, `+${denied}`]);
        await lease.release({ outcome: 'success', actualTokenUnits: 10 });
        await lease.release({ outcome: 'success', actualTokenUnits: 0 });
        assert.deepEqual(await totals(), [10, 10]);
      } finally {
        client.destroy();
        await f.inspector.sendCommand(['ACL', 'DELUSER', username]);
      }
    }
  });
  await t.test('server-clock rolling rate window expires, including conservative partial-second overlap', async () => {
    const service = await f.open();
    const limits = { account: { rpm: 1, rateWindowMs: 10 } };
    await admitted(await service.acquire(input({ limits }))).release();
    assert.equal((await service.acquire(input({ limits }))).allowed, false);
    await delay(1050);
    admitted(await service.acquire(input({ limits })));
  });
  await t.test(
    'lost acquire/release ACK can retry same token without double acquire, rate increment or release',
    async () => {
      const info = await f.inspector.info('server');
      const runId = /^run_id:(\w+)\r?$/m.exec(info)?.[1];
      assert.ok(runId);
      let lose = false;
      const service = createRedisFastGatewayAdmission({
        redis: {
          eval: async (script, options) => {
            const result = await f.inspector.eval(script, options);
            if (lose) {
              lose = false;
              throw new Error('Injected lost ACK after real Redis executed');
            }
            return result;
          },
        },
        namespace: randomUUID(),
        runId,
        maxTtlMs: 5000,
        renewIntervalMs: 100,
      });
      await service.initialize({ drained: true });
      const request = input({
        acquisitionToken: randomUUID(),
        limits: { account: { rpm: 2, tpm: 12, concurrency: 1 } },
      });
      lose = true;
      assert.deepEqual(await service.acquire(request), { allowed: false, reason: 'unavailable' });
      const lease = admitted(await service.acquire(request));
      assert.equal((await service.acquire({ ...request, tokenUnits: 8 })).allowed, false);
      assert.equal((await service.acquire({ ...request, acquisitionToken: randomUUID() })).allowed, false);
      lose = true;
      await assert.rejects(lease.release({ outcome: 'success', actualTokenUnits: 2 }), /release unavailable/);
      await lease.release({ outcome: 'success', actualTokenUnits: 2 });
      assert.equal((await service.acquire(request)).allowed, false);
      admitted(await service.acquire({ ...request, requestId: randomUUID(), acquisitionToken: randomUUID() }));
    },
  );
  await t.test(
    'renewal holds long streams beyond original TTL; stale renewal fails but slot remains through grace',
    async () => {
      const service = await f.open(undefined, { renewIntervalMs: 400 });
      const request = input({ ttlMs: 2000, limits: { account: { concurrency: 1 } } });
      const lease = admitted(await service.acquire(request));
      for (let i = 0; i < 5; i++) {
        await delay(500);
        await lease.renew();
      }
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
      await delay(1300);
      assert.equal(await lease.assertValid(), false);
      await assert.rejects(lease.renew(), /lease lost/);
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
      await delay(2100);
      admitted(await service.acquire({ ...request, requestId: randomUUID() }));
      await lease.release(); // stale release may remove only its own fenced member
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
    },
  );
  await t.test('low custom grace covers a delayed valid send plus its full upstream lifetime', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace, { maxTtlMs: 90000, abortGraceMs: 1, renewIntervalMs: 10000 });
    const request = input({ ttlMs: 2000, limits: { account: { concurrency: 1 } } });
    const lease = admitted(await service.acquire(request));
    const tag = createHash('sha256')
      .update(JSON.stringify([namespace]))
      .digest('hex');
    const member = createHash('sha256')
      .update(JSON.stringify([request.tenantId, request.requestId]))
      .digest('hex');
    const leaseKey = `mr:fast:{${tag}}:lease:${member}`;
    const inspect = async () => {
      const raw = await f.inspector.get(leaseKey);
      assert.ok(raw);
      const record = JSON.parse(raw) as { renewBy: number; untilMs: number };
      // Latest permitted send + complete transport lifetime + independent abort grace.
      assert.equal(record.untilMs, record.renewBy + request.ttlMs + 1);
      const keys = await f.inspector.keys(`mr:fast:{${tag}}:slots:*`);
      for (const key of keys) assert.equal(await f.inspector.zScore(key, member), record.untilMs);
      return record;
    };
    const acquired = await inspect();
    await delay(300);
    assert.equal(await lease.assertValid(), true, 'delayed send still has a live ticket');
    await lease.renew();
    const renewed = await inspect();
    assert.ok(renewed.untilMs > acquired.untilMs);
    // At this time the old ttl+grace formula would have expired, but a late send
    // from the last acknowledged renewal could still be running. Do not renew.
    await delay(2200);
    assert.equal(await lease.assertValid(), false);
    assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
    const meta = JSON.parse((await f.inspector.get(`mr:fast:{${tag}}:generation`)) ?? '{}');
    assert.equal(meta.horizon, 90000 + 30000 + 1);
    await lease.release(); // test represents known upstream completion, not client abort
  });
  await t.test('a shorter shared lease never shortens the longer holder TTL', async () => {
    const service = await f.open();
    admitted(await service.acquire(input({ ttlMs: 800, limits: { account: { concurrency: 2 } } })));
    admitted(await service.acquire(input({ ttlMs: 40, limits: { account: { concurrency: 2 } } })));
    await delay(200);
    admitted(await service.acquire(input({ ttlMs: 800, limits: { account: { concurrency: 2 } } })));
    assert.equal((await service.acquire(input({ limits: { account: { concurrency: 2 } } }))).allowed, false);
  });
  await t.test(
    'completion atomically releases slot and records cooldown; success cannot clear another failure',
    async () => {
      const service = await f.open();
      const request = input({ model: 'model-a', limits: { account: { concurrency: 2 } } });
      const failure = admitted(await service.acquire(request));
      const success = admitted(await service.acquire({ ...request, requestId: randomUUID() }));
      await failure.release({ outcome: 'rate_limited', modelOnly: true, cooldownMs: 150 });
      await success.release({ outcome: 'success' });
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
      await admitted(await service.acquire({ ...request, requestId: randomUUID(), model: 'model-b' })).release();
      await delay(180);
      admitted(await service.acquire({ ...request, requestId: randomUUID() }));
    },
  );
  await t.test('missing sentinel and poisoned data fail closed; no request silently initializes Redis', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    admitted(await service.acquire(input()));
    const keys = await f.inspector.keys('mr:fast:*:generation');
    for (const key of keys) await f.inspector.del(key);
    assert.deepEqual(await service.acquire(input()), { allowed: false, reason: 'unavailable' });
    const reopened = await f.open(namespace, { drained: false });
    assert.equal(reopened.readyInMs, 61000);
    assert.equal((await reopened.acquire(input())).allowed, false);
    const badNamespace = randomUUID();
    const valid = await f.open(badNamespace);
    const hash = createHash('sha256')
      .update(JSON.stringify([badNamespace]))
      .digest('hex');
    await f.inspector.set(`mr:fast:{${hash}}:generation`, 'invalid-json');
    assert.deepEqual(await valid.acquire(input()), { allowed: false, reason: 'unavailable' });
    // Independently validate constructor and malformed policies; neither can fail open.
    assert.equal((await valid.acquire(input({ tokenUnits: Number.NaN }))).allowed, false);
    assert.equal((await valid.acquire(input({ limits: { tenant: { concurrency: -1 } } }))).allowed, false);
  });

  await t.test(
    'a real Redis ACL runtime failure after ZADD only over-reserves and never produces a lease',
    async () => {
      const namespace = randomUUID();
      const healthy = await f.open(namespace, { abortGraceMs: 100, renewIntervalMs: 50 });
      const info = await f.inspector.info('server');
      const runId = /^run_id:(\w+)\r?$/m.exec(info)?.[1];
      assert.ok(runId);
      const username = `fault-${randomUUID()}`;
      const password = randomUUID();
      await f.inspector.sendCommand([
        'ACL',
        'SETUSER',
        username,
        'reset',
        'on',
        `>${password}`,
        '~mr:fast:*',
        '+eval',
        '+time',
        '+get',
        '+type',
        '+zremrangebyscore',
        '+zcard',
        '+zadd',
        '+zrange',
        '+pexpireat',
      ]);
      const restricted = createClient({ url: f.url, username, password, socket: { reconnectStrategy: false } });
      restricted.on('error', () => {});
      await restricted.connect();
      try {
        const broken = createRedisFastGatewayAdmission({
          namespace,
          runId,
          redis: restricted,
          maxTtlMs: 5000,
          abortGraceMs: 100,
          renewIntervalMs: 50,
        });
        const request = input({ ttlMs: 100, limits: { account: { concurrency: 1 } } });
        assert.deepEqual(await broken.acquire(request), { allowed: false, reason: 'unavailable' });
        assert.deepEqual(await healthy.acquire({ ...request, requestId: randomUUID() }), {
          allowed: false,
          reason: 'rate_limited',
        });
        await delay(330);
        admitted(await healthy.acquire({ ...request, requestId: randomUUID() }));
      } finally {
        restricted.destroy();
        await f.inspector.sendCommand(['ACL', 'DELUSER', username]);
      }
    },
  );
  await t.test('a wrong-type scope fails closed before a receipt or another scope reservation is written', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    const tag = createHash('sha256')
      .update(JSON.stringify([namespace]))
      .digest('hex');
    const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const poisoned = `mr:fast:{${tag}}:rate:${hash(['account', 'platform', 'account-a'])}`;
    await f.inspector.lPush(poisoned, 'wrong-type');
    assert.deepEqual(await service.acquire(input()), { allowed: false, reason: 'unavailable' });
    const tenantSlots = `mr:fast:{${tag}}:slots:${hash(['tenant', 'tenant-a'])}`;
    assert.equal(await f.inspector.zCard(tenantSlots), 0);
    assert.equal((await f.inspector.keys(`mr:fast:{${tag}}:lease:*`)).length, 0);
    await f.inspector.del(poisoned);
    admitted(await service.acquire(input()));
  });
  await t.test('renew/release races are idempotent and cannot free another request', async () => {
    const service = await f.open();
    for (let index = 0; index < 20; index++) {
      const request = input({ limits: { account: { concurrency: 1 } } });
      const lease = admitted(await service.acquire(request));
      await Promise.allSettled([lease.renew(), lease.release(), lease.release()]);
      const other = admitted(await service.acquire({ ...request, requestId: randomUUID() }));
      await lease.release();
      assert.equal((await service.acquire({ ...request, requestId: randomUUID() })).allowed, false);
      await other.release();
    }
  });
  await t.test('readiness checks sentinel, identity and quarantine without writing authority', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    const tag = createHash('sha256')
      .update(JSON.stringify([namespace]))
      .digest('hex');
    const key = `mr:fast:{${tag}}:generation`;
    const original = await f.inspector.get(key);
    assert.ok(original);
    assert.equal(await service.checkReady(), true);
    assert.equal(await f.inspector.get(key), original);
    await f.inspector.del(key);
    assert.equal(await service.checkReady(), false);
    assert.equal(await f.inspector.exists(key), 0);
    const meta = JSON.parse(original);
    for (const changed of [
      { ...meta, runId: 'other-process' },
      { ...meta, horizon: 1 },
      { ...meta, readyAt: Date.now() + 60_000 },
    ]) {
      const value = JSON.stringify(changed);
      await f.inspector.set(key, value);
      assert.equal(await service.checkReady(), false);
      assert.equal(await f.inspector.get(key), value);
    }
    await f.inspector.set(key, original);
    assert.equal(await service.checkReady(), true);
    const quarantined = await f.open(randomUUID(), { drained: false });
    assert.equal(await quarantined.checkReady(), false);
    await service.close();
    assert.equal(await service.checkReady(), false);
  });
  await t.test('managed opener rejects eviction policies', async () => {
    await f.inspector.configSet('maxmemory-policy', 'allkeys-lru');
    try {
      await assert.rejects(f.open(), /Redis unavailable/);
    } finally {
      await f.inspector.configSet('maxmemory-policy', 'noeviction');
    }
  });
  await t.test('real process death rejects acquire/renew; reopening restored old sentinel quarantines', async () => {
    const namespace = randomUUID();
    const configuration = { maxTtlMs: 90000, abortGraceMs: 1, renewIntervalMs: 10000 };
    const service = await f.open(namespace, configuration);
    const lease = admitted(await service.acquire(input()));
    const keys = await f.inspector.keys('mr:fast:*:generation');
    const before = await Promise.all(keys.map(async (key) => [key, await f.inspector.get(key)] as const));
    await f.restart();
    assert.equal((await service.acquire(input())).allowed, false);
    await assert.rejects(lease.renew(), /lease lost/);
    const inspector = createClient({ url: f.url, socket: { reconnectStrategy: false } });
    inspector.on('error', () => {});
    await inspector.connect();
    try {
      for (const [key, value] of before) if (value) await inspector.set(key, value);
    } finally {
      inspector.destroy();
    }
    const restarted = await f.open(namespace, { ...configuration, drained: false });
    assert.equal(restarted.readyInMs, 90000 + 30000 + 1);
    assert.equal((await restarted.acquire(input())).allowed, false);
  });
});
