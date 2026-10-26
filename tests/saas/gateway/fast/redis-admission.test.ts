import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createRedisFastGatewayAdmission,
  type FastAdmissionInput,
  type RedisEvalClient,
} from '../../../../src/saas/gateway/fast/redis-admission.js';

const request = (): FastAdmissionInput => ({
  requestId: randomUUID(),
  tenantId: 'tenant-a',
  projectId: 'project-a',
  proxyKeyId: 'key-a',
  accountId: 'account-a',
  accountOwnerScope: 'platform',
  tokenUnits: 5,
  ttlMs: 1000,
  limits: { tenant: { rpm: 5, concurrency: 2 }, account: { concurrency: 2 } },
});
const create = (redis: RedisEvalClient) =>
  createRedisFastGatewayAdmission({
    redis,
    namespace: 'test',
    runId: 'process-identity',
    maxTtlMs: 5000,
    renewIntervalMs: 50,
  });

test('invalid identities, unsafe numbers and missing limit scopes cannot issue admission commands', async () => {
  let calls = 0;
  const admission = create({
    eval: async () => {
      calls++;
      return null;
    },
  });
  const base = request();
  for (const change of [
    { tokenUnits: Number.MAX_SAFE_INTEGER },
    { tokenUnits: -1 },
    { tokenUnits: Number.NaN },
    { accountOwnerScope: 'other-tenant' },
    { ttlMs: 5001 },
    { ttlMs: 0 },
    { requestId: '' },
    { limits: { tenant: { rpm: -1 } } },
    { limits: { tenant: { rateWindowMs: 60001 } } },
    { limits: { group: { rpm: 1 } } },
    { limits: { user: { concurrency: 1 } } },
  ])
    assert.deepEqual(await admission.acquire({ ...base, ...change }), { allowed: false, reason: 'unavailable' });
  assert.equal(calls, 0);
});

test('Redis faults and malformed replies fail closed, with no fallback or secret-bearing errors', async () => {
  for (const reply of [null, 1, '{}', '{"ok":true}', '{"ok":false,"reason":"anything"}', 'not-json']) {
    const admission = create({ eval: async () => reply });
    assert.deepEqual(await admission.acquire(request()), { allowed: false, reason: 'unavailable' });
  }
  const admission = create({
    eval: async () => {
      throw new Error('remote driver details');
    },
  });
  assert.deepEqual(await admission.acquire(request()), { allowed: false, reason: 'unavailable' });
});

test('late acquire ACK cannot produce a dispatch-valid lease', async () => {
  const admission = create({
    eval: async (_script, options) => {
      const parameters = JSON.parse(options.arguments[0] ?? '{}');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return JSON.stringify({ ok: true, token: parameters.token, renewInMs: 10 });
    },
  });
  assert.deepEqual(await admission.acquire(request()), { allowed: false, reason: 'unavailable' });
});

test('all scope keys have one namespace hash tag, include no raw identifiers, and do not change with limit values', async () => {
  const seen: string[][] = [];
  const admission = create({
    eval: async (_script, options) => {
      seen.push(options.keys);
      return '{"ok":false,"reason":"unavailable"}';
    },
  });
  const base = request();
  await admission.acquire(base);
  await admission.acquire({ ...base, limits: { tenant: { rpm: 1, concurrency: 1 } } });
  assert.deepEqual(seen[0], seen[1]);
  const tags = new Set(seen[0]?.map((key) => /\{([^}]+)\}/.exec(key)?.[1]));
  assert.equal(tags.size, 1);
  for (const key of seen[0] ?? []) {
    for (const raw of [base.tenantId, base.projectId, base.proxyKeyId, base.accountId, base.requestId])
      assert.equal(key.includes(raw), false);
  }
});

test('renewal failure invalidates locally without sending an implicit release', async () => {
  let calls = 0;
  const admission = create({
    eval: async (_script, options) => {
      calls++;
      if (calls > 1) throw new Error('Redis unavailable');
      const parameters = JSON.parse(options.arguments[0] ?? '{}');
      return JSON.stringify({ ok: true, token: parameters.token, renewInMs: 150 });
    },
  });
  const result = await admission.acquire(request());
  assert.equal(result.allowed, true);
  if (!result.allowed) throw new Error('Expected lease');
  await assert.rejects(result.lease.renew(), /lease lost/);
  assert.equal(await result.lease.assertValid(), false);
  assert.equal(calls, 2);
});

test('actual-token feedback is bounded by the original lease and successful receipt outcome', async () => {
  let calls = 0;
  const service = create({
    eval: async (_script, options) => {
      calls++;
      const p = JSON.parse(options.arguments[0]);
      return JSON.stringify({ ok: true, token: p.token, renewInMs: 100 });
    },
  });
  const admitted = await service.acquire(request());
  assert.equal(admitted.allowed, true);
  if (!admitted.allowed) return;
  for (const actualTokenUnits of [-1, 6, 1.5, Number.NaN]) {
    await assert.rejects(
      admitted.lease.release({ outcome: 'success', actualTokenUnits }),
      /Invalid fast admission feedback/,
    );
  }
  await assert.rejects(
    admitted.lease.release({ outcome: 'failure', actualTokenUnits: 1 }),
    /Invalid fast admission feedback/,
  );
  assert.equal(calls, 1);
  await admitted.lease.release({ outcome: 'success', actualTokenUnits: 2 });
  assert.equal(calls, 2);
});
