import { type FastGatewaySnapshotCacheStore, FastGatewaySnapshotError } from './snapshots.js';

export interface FastGatewaySnapshotRedisCommands {
  sendCommand(args: string[]): Promise<unknown>;
}

/**
 * Narrow adapter for the managed @redis/client connection. Unlike the legacy
 * runtime cache, errors are NOT converted to misses, writes are acknowledged,
 * and GET never extends TTL. The enclosing cache encrypts all bytes first.
 */
export function createRedisFastGatewaySnapshotCacheStore(
  client: FastGatewaySnapshotRedisCommands,
  maxBytes = 2 * 1024 * 1024 + 28,
): FastGatewaySnapshotCacheStore {
  if (
    !client ||
    typeof client.sendCommand !== 'function' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 4 * 1024 * 1024
  )
    throw new TypeError('Invalid snapshot Redis adapter');
  const reject = (): never => {
    throw new FastGatewaySnapshotError('SNAPSHOT_UNAVAILABLE');
  };
  const validKey = (key: string) => typeof key === 'string' && /^[a-zA-Z0-9:_-]{1,128}:[0-9a-f]{64}$/.test(key);
  return {
    async get(key) {
      if (!validKey(key)) reject();
      try {
        const reply = await client.sendCommand(['GET', key]);
        if (reply === null) return null;
        if (
          typeof reply !== 'string' ||
          reply.length > Math.ceil(maxBytes / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(reply)
        )
          return reject();
        const value = Buffer.from(reply, 'base64');
        if (value.length === 0 || value.length > maxBytes || value.toString('base64') !== reply) return reject();
        return value;
      } catch {
        return reject();
      }
    },
    async set(key, value, ttlMs) {
      if (
        !validKey(key) ||
        !Buffer.isBuffer(value) ||
        value.length === 0 ||
        value.length > maxBytes ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > 30_000
      )
        reject();
      try {
        if ((await client.sendCommand(['SET', key, value.toString('base64'), 'PX', String(ttlMs)])) !== 'OK') reject();
      } catch {
        reject();
      }
    },
  };
}
