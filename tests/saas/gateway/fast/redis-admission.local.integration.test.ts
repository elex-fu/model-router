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
const namespacePrefix = (namespace: string) =>
  `mr:fast:{${createHash('sha256')
    .update(JSON.stringify([namespace]))
    .digest('hex')}}`;
function required(value: string | null): string {
  assert.notEqual(value, null);
  return value as string;
}
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
  await t.test('split release frees only concurrency; delayed durable usage refunds TPM once, not RPM', async () => {
    const namespace = randomUUID();
    const service = await f.open(namespace);
    const limits = { account: { concurrency: 1, tpm: 100, rpm: 100 } };
    const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits })));
    assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
    await lease.releaseConcurrency({ outcome: 'success' });
    const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
    const [rateKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:rate:*`);
    const record = JSON.parse(required(await f.inspector.get(leaseKey)));
    assert.equal(record.state, 'released');
    assert.equal(record.usageState, 'pending');
    const totals = async () =>
      Object.values(JSON.parse(required(await f.inspector.get(rateKey))).buckets as Record<string, number[]>).reduce(
        (sum, counts) => [sum[0] + counts[0], sum[1] + counts[1]],
        [0, 0],
      );
    assert.deepEqual(await totals(), [1, 90]);
    assert.equal((await service.acquire(input({ tokenUnits: 20, limits }))).allowed, false);
    const next = admitted(await service.acquire(input({ tokenUnits: 10, limits })));
    await lease.reconcileDurableUsage(10);
    await lease.reconcileDurableUsage(10);
    await lease.releaseConcurrency();
    await assert.rejects(lease.reconcileDurableUsage(0), /Invalid fast admission durable usage/);
    assert.deepEqual(await totals(), [2, 20]);
    assert.equal(
      (await service.acquire(input({ tokenUnits: 1, limits }))).allowed,
      false,
      'old release/reconciliation must not remove another request permit',
    );
    await next.release();
    admitted(await service.acquire(input({ tokenUnits: 80, limits })));
    assert.deepEqual(await totals(), [3, 100]);
  });
  await t.test(
    'durable usage before release retains the permit, renewal horizon and cross-instance idempotency',
    async () => {
      const namespace = randomUUID();
      const services = [await f.open(namespace), await f.open(namespace)];
      const limits = { account: { concurrency: 1, tpm: 100 } };
      const request = input({ acquisitionToken: randomUUID(), tokenUnits: 90, limits });
      const a = admitted(await services[0].acquire(request));
      const b = admitted(await services[1].acquire(request));
      assert.equal(a.fencingToken, b.fencingToken, 'retry returns canonical, not proposed incarnation');
      assert.ok(a.releaseConcurrency && a.reconcileDurableUsage && b.releaseConcurrency && b.reconcileDurableUsage);
      const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
      const before = JSON.parse(required(await f.inspector.get(leaseKey)));
      await a.reconcileDurableUsage(10);
      assert.equal(await a.assertValid(), true);
      const after = JSON.parse(required(await f.inspector.get(leaseKey)));
      assert.equal(after.state, 'active');
      assert.equal(after.untilMs, before.untilMs);
      assert.ok(
        (await f.inspector.pTTL(leaseKey)) > 86_400_000,
        'active reconciliation must preserve the remaining upstream/replay lifetime',
      );
      assert.equal((await services[0].acquire(input({ tokenUnits: 90, limits }))).allowed, false);
      await b.renew();
      const races = await Promise.allSettled([
        b.renew(),
        a.releaseConcurrency(),
        b.reconcileDurableUsage(10),
        b.releaseConcurrency(),
      ]);
      assert.equal(
        races.slice(1).every((result) => result.status === 'fulfilled'),
        true,
      );
      const [rateKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:rate:*`);
      const rate = JSON.parse(required(await f.inspector.get(rateKey)));
      assert.deepEqual(rate.buckets[before.bucket], [1, 10]);
      admitted(await services[0].acquire(input({ tokenUnits: 90, limits })));
      await a.releaseConcurrency();
      await b.reconcileDurableUsage(10);
      assert.equal((await services[1].acquire(input({ tokenUnits: 1, limits }))).allowed, false);
    },
  );
  await t.test(
    'lost split release and reconciliation ACKs retry without double refund or freeing a new permit',
    async () => {
      const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
      assert.ok(runId);
      const namespace = randomUUID();
      const lose = new Set(['concurrency', 'usage']);
      const service = createRedisFastGatewayAdmission({
        namespace,
        runId,
        maxTtlMs: 5000,
        renewIntervalMs: 50,
        redis: {
          eval: async (script, options) => {
            const result = await f.inspector.eval(script, options);
            const operation = options.arguments.length === 1 ? JSON.parse(options.arguments[0]).operation : undefined;
            if (lose.delete(operation)) throw new Error('Injected timeout after Redis executed');
            return result;
          },
        },
      });
      await service.initialize({ drained: true });
      const limits = { account: { concurrency: 1, tpm: 100 } };
      const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits })));
      assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
      await assert.rejects(lease.releaseConcurrency(), /release unavailable/);
      const next = admitted(await service.acquire(input({ tokenUnits: 10, limits })));
      await assert.rejects(lease.reconcileDurableUsage(10), /reconciliation unavailable/);
      await Promise.all([lease.releaseConcurrency(), lease.reconcileDurableUsage(10)]);
      assert.equal((await service.acquire(input({ tokenUnits: 1, limits }))).allowed, false);
      await next.release();
      admitted(await service.acquire(input({ tokenUnits: 80, limits })));
      assert.equal((await service.acquire(input({ tokenUnits: 1, limits }))).allowed, false);
    },
  );
  await t.test(
    'default release, old released records and missing immutable usage facts remain conservative',
    async () => {
      for (const variant of ['default', 'old-released', 'missing-bucket'] as const) {
        const namespace = randomUUID();
        const service = await f.open(namespace);
        const limits = { account: { tpm: 100 } };
        const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits })));
        assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
        const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
        if (variant === 'default') {
          await lease.release({ outcome: 'success' });
          await lease.release({ outcome: 'success', actualTokenUnits: 10 });
        } else {
          await lease.releaseConcurrency();
          const record = JSON.parse(required(await f.inspector.get(leaseKey)));
          if (variant === 'old-released') delete record.usageState;
          else {
            delete record.bucket;
            delete record.tokenUnits;
          }
          await f.inspector.set(leaseKey, JSON.stringify(record), { KEEPTTL: true });
        }
        await lease.reconcileDurableUsage(10);
        assert.equal((await service.acquire(input({ tokenUnits: 20, limits }))).allowed, false, variant);
      }
    },
  );
  await t.test(
    'pre-incarnation records cannot authorize replay or delayed feedback during rolling upgrade',
    async () => {
      const namespace = randomUUID();
      const service = await f.open(namespace);
      const limits = { account: { concurrency: 1, tpm: 100 } };
      const request = input({ acquisitionToken: randomUUID(), tokenUnits: 90, limits });
      const lease = admitted(await service.acquire(request));
      assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
      const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
      const record = JSON.parse(required(await f.inspector.get(leaseKey)));
      const ids = [
        request.requestId,
        request.tenantId,
        request.projectId,
        request.proxyKeyId,
        request.accountId,
        request.accountOwnerScope,
      ];
      const legacyLimits = [undefined, undefined, undefined, request.limits.account].map((limit) => ({
        rpm: limit?.rpm ?? 0,
        tpm: limit?.tpm ?? 0,
        concurrency: limit?.concurrency ?? 0,
        window: limit?.rateWindowMs ?? 60000,
      }));
      const legacyBinding = createHash('sha256')
        .update(
          JSON.stringify([
            ids,
            request.userId,
            request.groupId,
            request.model,
            request.tokenUnits,
            request.ttlMs,
            legacyLimits,
          ]),
        )
        .digest('hex');
      // Exact guard in 83a0538 redis-admission.ts:109-110; legacy ACQUIRE
      // checks it at :115-117 and RELEASE at :191 before any mutation.
      // Versioned binding must protect new split records even from old scripts
      // that do not inspect runId/incarnation/usageState.
      assert.equal(
        await f.inspector.eval(
          `local r=cjson.decode(redis.call('GET',KEYS[1]))
         return r.token==ARGV[1] and r.binding==ARGV[2] and 1 or 0`,
          { keys: [leaseKey], arguments: [required(request.acquisitionToken ?? null), legacyBinding] },
        ),
        0,
      );
      record.binding = legacyBinding;
      delete record.runId;
      delete record.incarnation;
      await f.inspector.set(leaseKey, JSON.stringify(record), { KEEPTTL: true });
      assert.deepEqual(await service.acquire(request), { allowed: false, reason: 'unavailable' });
      await assert.rejects(lease.reconcileDurableUsage(10), /reconciliation unavailable/);
      await assert.rejects(lease.releaseConcurrency(), /release unavailable/);
      assert.equal((await service.acquire(input({ tokenUnits: 1, limits }))).allowed, false);
      assert.deepEqual(JSON.parse(required(await f.inspector.get(leaseKey))), record);
    },
  );
  await t.test(
    'expired tombstones cannot let old feedback mutate a new incarnation of the same request and token',
    async () => {
      const namespace = randomUUID();
      const service = await f.open(namespace);
      const limits = { account: { concurrency: 1, tpm: 200 } };
      const request = input({ acquisitionToken: randomUUID(), tokenUnits: 90, limits });
      const old = admitted(await service.acquire(request));
      const oldRetry = admitted(await service.acquire(request));
      assert.ok(old.releaseConcurrency && old.reconcileDurableUsage && oldRetry.releaseConcurrency);
      await old.releaseConcurrency();
      const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
      // Real Redis expiry compresses only the replay retention clock for this ABA test.
      await f.inspector.pExpire(leaseKey, 1);
      await delay(10);
      assert.equal(await f.inspector.exists(leaseKey), 0);
      const fresh = admitted(await service.acquire(request));
      assert.notEqual(fresh.fencingToken, old.fencingToken);
      await assert.rejects(old.reconcileDurableUsage(10), /reconciliation unavailable/);
      await assert.rejects(oldRetry.releaseConcurrency(), /release unavailable/);
      await assert.rejects(oldRetry.renew(), /lease lost/);
      await assert.rejects(old.release({ outcome: 'success', actualTokenUnits: 10 }), /release unavailable/);
      const [rateKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:rate:*`);
      const totals = Object.values(
        JSON.parse(required(await f.inspector.get(rateKey))).buckets as Record<string, number[]>,
      );
      assert.equal(
        totals.reduce((sum, counts) => sum + counts[1], 0),
        180,
      );
      assert.equal((await service.acquire(input({ tokenUnits: 1, limits }))).allowed, false);
      await fresh.renew();
      await fresh.release({ outcome: 'success', actualTokenUnits: 10 });
    },
  );
  await t.test(
    'pending split tombstones outlive the original rate bucket even with short replay retention',
    async () => {
      const namespace = randomUUID();
      const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
      assert.ok(runId);
      const service = createRedisFastGatewayAdmission({
        namespace,
        runId,
        redis: f.inspector,
        maxTtlMs: 100,
        renewIntervalMs: 50,
        abortGraceMs: 1,
        replayRetentionMs: 101,
      });
      await service.initialize({ drained: true });
      const lease = admitted(
        await service.acquire(input({ ttlMs: 100, tokenUnits: 90, limits: { account: { tpm: 100 } } })),
      );
      assert.ok(lease.releaseConcurrency);
      await lease.releaseConcurrency();
      const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
      assert.ok((await f.inspector.pTTL(leaseKey)) >= 59_900);
    },
  );
  await t.test('expired usage no-write result begins exactly at bucket-end plus 60000ms', async () => {
    const namespace = randomUUID();
    const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
    assert.ok(runId);
    let injectedServerNow: number | undefined;
    const service = createRedisFastGatewayAdmission({
      namespace,
      runId,
      maxTtlMs: 5000,
      renewIntervalMs: 50,
      redis: {
        eval: (script, options) => {
          // Deterministic boundary fault injection inside REAL Redis Lua. The
          // separate natural-expiry test exercises the unmodified Redis TIME path.
          if (injectedServerNow !== undefined)
            script = script.replace(
              'local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)',
              `local now=${injectedServerNow}`,
            );
          return f.inspector.eval(script, options);
        },
      },
    });
    await service.initialize({ drained: true });
    const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits: { account: { tpm: 100 } } })));
    assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
    await lease.releaseConcurrency();
    const [leaseKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
    const record = JSON.parse(required(await f.inspector.get(leaseKey)));
    const [rateKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:rate:*`);
    const unchanged = await f.inspector.get(rateKey);
    await f.inspector.del(leaseKey);
    injectedServerNow = Number(record.bucket) * 1000 + 61000 - 1;
    await assert.rejects(lease.reconcileDurableUsage(10), /reconciliation unavailable/);
    assert.equal(await f.inspector.get(rateKey), unchanged);
    injectedServerNow++;
    await lease.reconcileDurableUsage(10);
    assert.equal(await f.inspector.get(rateKey), unchanged);
    assert.equal(await f.inspector.exists(leaseKey), 0);
  });
  await t.test('real server-clock rollover reconciles only the immutable admission bucket', async () => {
    for (const mode of ['legacy', 'split']) {
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
      const original = JSON.parse(required(await f.inspector.get(leaseKey)));
      for (;;) {
        const clock = (await f.inspector.sendCommand(['TIME'])) as string[];
        if (Number(clock[0]) > Number(original.bucket)) break;
        await delay(10);
      }
      admitted(await service.acquire(input({ tokenUnits: 90, ttlMs: 5000, limits })));
      if (mode === 'legacy') await first.release({ outcome: 'success', actualTokenUnits: 10 });
      else {
        assert.ok(first.releaseConcurrency && first.reconcileDurableUsage);
        await first.releaseConcurrency();
        await first.reconcileDurableUsage(10);
      }
      const [rateKey] = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
      const rate = JSON.parse(required(await f.inspector.get(rateKey)));
      assert.equal(rate.buckets[original.bucket][1], 10);
      const newer = Object.entries(rate.buckets).filter(([bucket]) => bucket !== original.bucket);
      assert.equal(newer.length, 1);
      assert.equal((newer[0][1] as number[])[1], 90);
      admitted(await service.acquire(input({ tokenUnits: 100, ttlMs: 5000, limits })));
    }
  });
  await t.test('a pruned original bucket never refunds a newer bucket', async () => {
    for (const mode of ['legacy', 'split']) {
      const namespace = randomUUID();
      const service = await f.open(namespace);
      const lease = admitted(await service.acquire(input({ tokenUnits: 90, limits: { account: { tpm: 100 } } })));
      const tag = createHash('sha256')
        .update(JSON.stringify([namespace]))
        .digest('hex');
      const [leaseKey] = await f.inspector.keys(`mr:fast:{${tag}}:lease:*`);
      const receipt = JSON.parse(required(await f.inspector.get(leaseKey)));
      const [rateKey] = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
      const newerBucket = String(Number(receipt.bucket) + 1);
      const replacement = { buckets: { [newerBucket]: [1, 30] } };
      await f.inspector.set(rateKey, JSON.stringify(replacement), { PX: 61000 });
      if (mode === 'legacy') await lease.release({ outcome: 'success', actualTokenUnits: 1 });
      else {
        assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
        await lease.releaseConcurrency();
        await lease.reconcileDurableUsage(1);
      }
      assert.deepEqual(JSON.parse(required(await f.inspector.get(rateKey))), replacement);
    }
  });
  await t.test('atomic TPM reconciliation survives denied MSET and post-MSET expiry errors', async () => {
    const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
    assert.ok(runId);
    for (const mode of ['legacy', 'split'] as const) {
      for (const denied of ['mset', 'pexpireat']) {
        const namespace = randomUUID();
        await f.open(namespace);
        const username = `quota-${randomUUID()}`;
        const password = randomUUID();
        await f.inspector.sendCommand([
          'ACL',
          'SETUSER',
          username,
          'reset',
          'on',
          `>${password}`,
          '~mr:fast:*',
          '+@all',
        ]);
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
          assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage);
          if (mode === 'split') await lease.releaseConcurrency();
          const reconcileUsage = lease.reconcileDurableUsage;
          const reconcile = () =>
            mode === 'split' ? reconcileUsage(10) : lease.release({ outcome: 'success', actualTokenUnits: 10 });
          const tag = createHash('sha256')
            .update(JSON.stringify([namespace]))
            .digest('hex');
          const keys = await f.inspector.keys(`mr:fast:{${tag}}:rate:*`);
          assert.equal(keys.length, 2);
          const totals = async () =>
            Promise.all(
              keys.map(async (key) =>
                Object.values(
                  JSON.parse(required(await f.inspector.get(key))).buckets as Record<string, number[]>,
                ).reduce((total, counts) => total + counts[1], 0),
              ),
            );
          await f.inspector.sendCommand(['ACL', 'SETUSER', username, `-${denied}`]);
          await assert.rejects(reconcile(), /unavailable/);
          assert.deepEqual(await totals(), denied === 'mset' ? [90, 90] : [10, 10]);
          await f.inspector.sendCommand(['ACL', 'SETUSER', username, `+${denied}`]);
          await reconcile();
          await reconcile();
          if (mode === 'legacy') await lease.release({ outcome: 'success', actualTokenUnits: 0 });
          else await assert.rejects(lease.reconcileDurableUsage(0), /Invalid fast admission durable usage/);
          assert.deepEqual(await totals(), [10, 10]);
        } finally {
          client.destroy();
          await f.inspector.sendCommand(['ACL', 'DELUSER', username]);
        }
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
  await t.test(
    'real process death rejects stale acquire/renew/reconcile; restored old state still quarantines',
    async () => {
      const namespace = randomUUID();
      const configuration = { maxTtlMs: 90000, abortGraceMs: 1, renewIntervalMs: 10000 };
      const service = await f.open(namespace, configuration);
      const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
      assert.ok(runId);
      let currentInspector = f.inspector;
      const replaying = createRedisFastGatewayAdmission({
        ...configuration,
        namespace,
        runId,
        redis: { eval: (script, options) => currentInspector.eval(script, options) },
      });
      const request = input({
        acquisitionToken: randomUUID(),
        tokenUnits: 90,
        limits: { account: { tpm: 100, concurrency: 1 } },
      });
      const lease = admitted(await replaying.acquire(request));
      const retry = admitted(await replaying.acquire(request));
      assert.ok(lease.releaseConcurrency && lease.reconcileDurableUsage && retry.releaseConcurrency);
      await lease.releaseConcurrency();
      const keys = await f.inspector.keys(`${namespacePrefix(namespace)}:*`);
      const before = await Promise.all(keys.map(async (key) => [key, await f.inspector.get(key)] as const));
      await f.restart();
      assert.equal((await service.acquire(input())).allowed, false);
      await assert.rejects(retry.renew(), /lease lost/);
      await assert.rejects(lease.reconcileDurableUsage(10), /reconciliation unavailable/);
      const inspector = createClient({ url: f.url, socket: { reconnectStrategy: false } });
      inspector.on('error', () => {});
      await inspector.connect();
      try {
        for (const [key, value] of before) if (value) await inspector.set(key, value);
        const restarted = await f.open(namespace, { ...configuration, drained: false });
        assert.equal(restarted.readyInMs, 90000 + 30000 + 1);
        assert.equal((await restarted.acquire(input())).allowed, false);
        currentInspector = inspector;
        assert.deepEqual(await replaying.acquire(request), { allowed: false, reason: 'unavailable' });
        await assert.rejects(lease.reconcileDurableUsage(10), /reconciliation unavailable/);
        await assert.rejects(retry.releaseConcurrency(), /release unavailable/);
        for (const [key, value] of before) {
          if (!key.endsWith(':generation'))
            assert.equal(
              await inspector.get(key),
              value,
              'old commands cannot mutate restored state under a new run-id sentinel',
            );
        }
      } finally {
        inspector.destroy();
      }
    },
  );
});

test('server-clock expiry closes missing/restarted rate-only work without touching new authority', {
  skip: !enabled,
  timeout: 75000,
}, async (t) => {
  const f = await fixture(t);
  const namespace = randomUUID();
  const runId = /^run_id:(\w+)\r?$/m.exec(await f.inspector.info('server'))?.[1];
  assert.ok(runId);
  let currentInspector = f.inspector;
  const configuration = { maxTtlMs: 100, abortGraceMs: 1, renewIntervalMs: 50, replayRetentionMs: 101 };
  const service = createRedisFastGatewayAdmission({
    ...configuration,
    namespace,
    runId,
    redis: { eval: (script, options) => currentInspector.eval(script, options) },
  });
  await service.initialize({ drained: true });
  const limits = { account: { tpm: 1000, concurrency: 1 } };
  const request = () => input({ acquisitionToken: randomUUID(), ttlMs: 100, tokenUnits: 90, limits });
  const missing = admitted(await service.acquire(request()));
  assert.ok(missing.releaseConcurrency && missing.reconcileDurableUsage);
  await missing.releaseConcurrency();
  const replayRequest = request();
  const stale = admitted(await service.acquire(replayRequest));
  assert.ok(stale.releaseConcurrency && stale.reconcileDurableUsage);
  await stale.releaseConcurrency();
  const restarted = admitted(await service.acquire(request()));
  assert.ok(restarted.releaseConcurrency && restarted.reconcileDurableUsage);
  await restarted.releaseConcurrency();
  const keys = await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`);
  const records = await Promise.all(keys.map(async (key) => JSON.parse(required(await f.inspector.get(key)))));
  const expiresAt = Math.max(...records.map((record) => Number(record.bucket) * 1000 + 61000));
  const tombstoneExpiries = await Promise.all(keys.map((key) => f.inspector.pExpireTime(key)));
  t.diagnostic(JSON.stringify({ bucketExpiresAt: expiresAt, tombstoneExpiries }));
  // Rate irrelevance and tombstone disappearance are separate conditions.
  // SET PX uses Redis's command clock, and PTTL=0 may still mean a live key
  // at its exact expiry millisecond. Observe each original tombstone until
  // PTTL=-2 instead of assuming bucket expiry also proves key disappearance.
  // The long wait still uses real Redis TIME and natural TTL expiry only.
  for (;;) {
    const time = (await f.inspector.sendCommand(['TIME'])) as string[];
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    const ttls = await Promise.all(keys.map((key) => f.inspector.pTTL(key)));
    assert.ok(
      ttls.every((ttl) => ttl === -2 || ttl >= 0),
      `Unexpected persistent tombstone: ${JSON.stringify(ttls)}`,
    );
    if (now >= expiresAt && ttls.every((ttl) => ttl === -2)) break;
    const untilMissing = Math.max(0, ...ttls.map((ttl) => (ttl >= 0 ? ttl + 1 : 0)));
    await delay(Math.min(1000, Math.max(expiresAt - now, untilMissing)));
  }
  assert.equal((await f.inspector.keys(`${namespacePrefix(namespace)}:lease:*`)).length, 0);
  const fresh = admitted(await service.acquire(replayRequest));
  const [rateKey] = await f.inspector.keys(`${namespacePrefix(namespace)}:rate:*`);
  const newRate = await f.inspector.get(rateKey);
  await missing.reconcileDurableUsage(10);
  assert.equal(await f.inspector.get(rateKey), newRate);
  await assert.rejects(stale.reconcileDurableUsage(10), /reconciliation unavailable/);
  assert.equal(await f.inspector.get(rateKey), newRate);
  const generationKey = `${namespacePrefix(namespace)}:generation`;
  const generation = required(await f.inspector.get(generationKey));
  await fresh.release();
  await f.restart();
  const inspector = createClient({ url: f.url, socket: { reconnectStrategy: false } });
  inspector.on('error', () => {});
  await inspector.connect();
  currentInspector = inspector;
  try {
    await assert.rejects(
      restarted.reconcileDurableUsage(10),
      /reconciliation unavailable/,
      'an absent authority sentinel is not proof of safe completion',
    );
    for (const invalid of [
      'not-json',
      JSON.stringify({ ...JSON.parse(generation), runId: '' }),
      JSON.stringify({ ...JSON.parse(generation), horizon: 1 }),
      JSON.stringify({ ...JSON.parse(generation), readyAt: -1 }),
    ]) {
      await inspector.set(generationKey, invalid);
      await assert.rejects(restarted.reconcileDurableUsage(10), /reconciliation unavailable/);
      assert.equal(await inspector.get(generationKey), invalid);
    }
    await inspector.set(generationKey, generation);
    const reopened = await f.open(namespace, { ...configuration, drained: false });
    assert.equal(reopened.readyInMs, 61000);
    assert.equal(await reopened.checkReady(), false);
    const time = (await inspector.sendCommand(['TIME'])) as string[];
    const replacement = JSON.stringify({ buckets: { [time[0]]: [1, 70] } });
    await inspector.set(rateKey, replacement, { PX: 61000 });
    const newGeneration = await inspector.get(generationKey);
    await restarted.reconcileDurableUsage(10);
    assert.equal(await inspector.get(rateKey), replacement, 'expired usage cannot refund the new generation');
    assert.equal(await inspector.get(generationKey), newGeneration, 'expiry completion cannot alter quarantine');
    assert.equal((await inspector.keys(`${namespacePrefix(namespace)}:lease:*`)).length, 0);
  } finally {
    inspector.destroy();
  }
});
