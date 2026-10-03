import { createHash } from 'node:crypto';
import type { ManagedRateLimiter, RedisProvider, RedisProviderFactoryOptions, RedisRateLimiterOptions } from './providers.js';
import { RedisRespClient, RedisRespError } from './redis-resp-client.js';

// https://redis.io/docs/latest/commands/eval/
// https://redis.io/docs/latest/commands/set/ (PX) and /pttl/
// Fixed window starting at the first accepted request. One declared key only.
// SET+PX creates count and expiry together: no INCR/EXPIRE failure gap, even
// if an ACL rejects a later command (scripts are atomic, not rollback transactions).
export const AUTH_RATE_LIMIT_SCRIPT = [
  'local limit = tonumber(ARGV[1])',
  'local window = tonumber(ARGV[2])',
  'local ttl = redis.call("PTTL", KEYS[1])',
  'if ttl == -2 then',
  '  redis.call("SET", KEYS[1], "1", "PX", ARGV[2])',
  '  return {1, window}',
  'end',
  'if ttl < 0 or ttl > window then return redis.error_reply("RATE_LIMIT_STATE") end',
  'local raw = redis.call("GET", KEYS[1])',
  'local count = tonumber(raw)',
  'if not count or count < 1 or count > limit or count ~= math.floor(count) or tostring(count) ~= raw then',
  '  return redis.error_reply("RATE_LIMIT_STATE")',
  'end',
  'if ttl == 0 then return {0, 1} end',
  'if count >= limit then return {0, ttl} end',
  'redis.call("INCR", KEYS[1])',
  'return {1, ttl}',
].join('\n');

function limiterOptions(options: RedisRateLimiterOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['namespace', 'limit', 'windowMs'].includes(key)) ||
      !['customer-auth', 'platform-auth'].includes(options.namespace) ||
      !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000_000 ||
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1 || options.windowMs > 86_400_000) {
    throw new RedisRespError('REDIS_INVALID_LIMITER');
  }
}

/** Named export for the existing trusted dynamic provider loader; no gateway use. */
export async function createRedisProvider(options: RedisProviderFactoryOptions): Promise<RedisProvider> {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['url', 'keyPrefix'].includes(key)) ||
      typeof options.url !== 'string' || typeof options.keyPrefix !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(options.keyPrefix)) {
    throw new RedisRespError('REDIS_INVALID_OPTIONS');
  }
  const prefix = options.keyPrefix;
  const client = await RedisRespClient.connect(options.url);
  return rateLimitProvider(client, prefix);
}

// The long-lived view is constructed outside the factory's URL/options scope.
function rateLimitProvider(client: RedisRespClient, prefix: string): RedisProvider {
  let closed = false;
  let closing: Promise<void> | undefined;
  function requireOpen(): void {
    if (closed) throw new RedisRespError('REDIS_CLOSED');
  }
  return {
    createRateLimiter(configuration): ManagedRateLimiter {
      requireOpen(); limiterOptions(configuration);
      // Copy primitives; callers cannot mutate a live limiter's policy.
      const { namespace, limit, windowMs } = configuration;
      return {
        async take(key): Promise<number | undefined> {
          requireOpen();
          if (typeof key !== 'string' || key.length === 0 || key.length > 4_096 ||
              key.includes('\0') || Buffer.byteLength(key) > 4_096 || Buffer.from(key).toString('utf8') !== key) {
            throw new RedisRespError('REDIS_INVALID_KEY');
          }
          const digest = createHash('sha256').update('model-router:auth-rate-limit:v1\0')
            .update(prefix).update('\0').update(namespace).update('\0')
            .update(String(limit)).update('\0').update(String(windowMs)).update('\0').update(key).digest('hex');
          const redisKey = prefix + ':auth-rate-limit:v1:' + namespace + ':' + limit + ':' + windowMs + ':' + digest;
          const reply = await client.command(['EVAL', AUTH_RATE_LIMIT_SCRIPT, '1', redisKey, String(limit), String(windowMs)]);
          if (!Array.isArray(reply) || reply.length !== 2) client.invalidate('REDIS_PROTOCOL_ERROR');
          const [allowed, ttl] = reply;
          if ((allowed !== 0 && allowed !== 1) || typeof ttl !== 'number' ||
              !Number.isSafeInteger(ttl) || ttl < 1 || ttl > windowMs) client.invalidate('REDIS_PROTOCOL_ERROR');
          // HTTP callers consume Retry-After SECONDS, not Redis PTTL milliseconds.
          return allowed === 1 ? undefined : Math.ceil(ttl / 1_000);
        },
      };
    },
    async checkReady(): Promise<void> {
      requireOpen();
      if (await client.command(['PING']) !== 'PONG') client.invalidate('REDIS_PROTOCOL_ERROR');
    },
    close(): Promise<void> {
      if (closing === undefined) { closed = true; closing = client.close(); }
      return closing;
    },
  };
}
