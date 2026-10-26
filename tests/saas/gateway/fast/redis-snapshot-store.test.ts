import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createRedisFastGatewaySnapshotCacheStore } from '../../../../src/saas/gateway/fast/redis-snapshot-store.js';
import { FastGatewaySnapshotError } from '../../../../src/saas/gateway/fast/snapshots.js';

const key = `model-router:fast:v1:${'a'.repeat(64)}`;
test('Redis snapshot adapter uses acknowledged fixed TTL SET and non-refreshing GET', async () => {
  const commands: string[][] = [];
  const value = randomBytes(7000);
  const store = createRedisFastGatewaySnapshotCacheStore({
    async sendCommand(args) {
      commands.push(args);
      return args[0] === 'GET' ? value.toString('base64') : 'OK';
    },
  });
  await store.set(key, value, 1234);
  assert.deepEqual(await store.get(key), value);
  assert.deepEqual(commands, [
    ['SET', key, value.toString('base64'), 'PX', '1234'],
    ['GET', key],
  ]);
});
test('Redis snapshot adapter distinguishes acknowledged miss from every failure', async () => {
  assert.equal(
    await createRedisFastGatewaySnapshotCacheStore({
      async sendCommand() {
        return null;
      },
    }).get(key),
    null,
  );
  for (const value of [undefined, 0, [], 'not-base64', 'A'])
    await assert.rejects(
      createRedisFastGatewaySnapshotCacheStore({
        async sendCommand() {
          return value;
        },
      }).get(key),
      FastGatewaySnapshotError,
    );
  const store = createRedisFastGatewaySnapshotCacheStore({
    async sendCommand() {
      throw new Error(randomBytes(10).toString('hex'));
    },
  });
  await assert.rejects(store.get(key), { message: 'Fast gateway authority unavailable' });
  await assert.rejects(store.set(key, randomBytes(10), 1000), { message: 'Fast gateway authority unavailable' });
  await assert.rejects(
    createRedisFastGatewaySnapshotCacheStore({
      async sendCommand() {
        return null;
      },
    }).set(key, randomBytes(10), 1000),
    FastGatewaySnapshotError,
  );
});
test('Redis snapshot adapter bounds values, keys, and TTL before network calls', async () => {
  let calls = 0;
  const store = createRedisFastGatewaySnapshotCacheStore(
    {
      async sendCommand() {
        calls++;
        return 'OK';
      },
    },
    16,
  );
  await assert.rejects(store.get('raw-value'), FastGatewaySnapshotError);
  await assert.rejects(store.set(key, randomBytes(17), 1000), FastGatewaySnapshotError);
  await assert.rejects(store.set(key, randomBytes(10), 30_001), FastGatewaySnapshotError);
  assert.equal(calls, 0);
});
