import { createHash } from 'node:crypto';
import type { RedisRespClient, RedisRespValue } from './redis-resp-client.js';

/**
 * R6b Redis hot state (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6b, task #32): the sub2api concurrency-slot ZSET, the sticky-session
 * fast path and the short-TTL token-decrypt cache, on the shared
 * RedisRespClient (single-key EVAL only — the client's protocol allowlist
 * is the security boundary).
 *
 * STRICT ROLE (red line): everything here is a scheduling PRE-CHECK or a
 * cache. PostgreSQL stays authoritative — the PG lease
 * (provider-account-lease-service) remains the final admission before
 * dispatch, the PG affinity table (041) remains the durable affinity source,
 * and the sealed credential envelope in PG remains the credential of record.
 * Redis unavailable ⇒ fail-open to the pure-PG path ('unavailable' states
 * below); availability first, lease backstop. Nothing here ever fails a
 * request closed.
 *
 * Slot semantics (sub2api parity):
 * - one ZSET per dimension; member = requestId, score = redis TIME (server
 *   clock, never JS time — the score is the lease evidence);
 * - ZREMRANGEBYSCORE lazily evicts members older than the slot window
 *   before the gate, so a crashed holder cannot wedge a slot forever;
 * - an existing member refreshes its score (idempotent acquire retry);
 * - ZCARD < maxSlots is the gate (the pre-check SHAPE only — the PG lease
 *   is still acquired afterwards and remains the authority);
 * - a key-level PEXPIRE is the double insurance against a lost release.
 *
 * Sticky semantics: mr:sticky:{pool}:{sessionHash} → accountId with a 1h
 * SLIDING TTL — every read that still hits refreshes the window atomically
 * (GET+PEXPIRE in one script), so the 1h bound applies to idle sessions
 * rather than to the mapping's absolute age. The sessionHash priority is
 * sub2api's: session-id header → conversation_id → prompt_cache_key →
 * content-hash fallback. Binding changes invalidate by TTL expiry: the RESP
 * client deliberately has no SUBSCRIBE, so PubSub invalidation is NOT wired
 * — the sliding TTL bounds drift for active sessions and the PG affinity
 * source remains authoritative (documented deviation).
 *
 * Token-decrypt cache: 60s TTL keyed by the sealed envelope digest, so a
 * key rotation (different ciphertext) misses by construction. Cached
 * plaintext is stored base64 and materialized into a FRESH Buffer per read
 * — the unsealer zeroizes the buffer it hands out, so a shared cached
 * Buffer would be zeroized under a concurrent reader.
 *
 * Keys are digested (rate-limit provider precedent): raw account ids,
 * session references and envelope bytes never appear in Redis keys.
 */

/** The RESP surface the hot-state clients need; invalidate is optional (test doubles). */
export type RedisHotStateClient = Pick<RedisRespClient, 'command'> & {
  readonly invalidate?: (code: 'REDIS_PROTOCOL_ERROR') => never;
};

/** One acquired-or-rejected slot decision; 'unavailable' means fail-open. */
export type RedisConcurrencySlotDecision =
  | { readonly state: 'acquired' }
  | { readonly state: 'saturated' }
  | { readonly state: 'unavailable' };

export interface RedisConcurrencySlotInput {
  /** Owner scope key ('platform' or the tenant id) — the account dimension. */
  readonly ownerScopeKey: string;
  readonly accountId: string;
  /** The dispatch unit (sub2api: the request id is the ZSET member). */
  readonly requestId: string;
  readonly maxSlots: number;
  /** How long an unreleased member occupies a slot (lazy-eviction window). */
  readonly windowMs: number;
}

export interface RedisConcurrencySlots {
  tryAcquire(input: RedisConcurrencySlotInput): Promise<RedisConcurrencySlotDecision>;
  release(input: Pick<RedisConcurrencySlotInput, 'ownerScopeKey' | 'accountId' | 'requestId'>): Promise<void>;
}

export interface RedisCacheEntry {
  readonly value: Buffer | null;
  readonly state: 'hit' | 'miss' | 'unavailable';
}

export interface RedisRuntimeCache {
  get(key: string): Promise<RedisCacheEntry>;
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
  /**
   * Sticky-path read: returns the value and atomically refreshes the key's
   * TTL on a hit (the idle window slides); a miss touches nothing. The TTL
   * argument is the full sliding window, not a delta.
   */
  getAndRefreshTtl(key: string, ttlMs: number): Promise<RedisCacheEntry>;
  /**
   * Sticky-path clear (batch 2 §2.1): best-effort single-key delete. Never
   * throws — a failed clear only leaves a stale cache row that the next
   * resolve re-checks against eligibility anyway.
   */
  delete(key: string): Promise<void>;
}

export interface RedisRuntimeCacheOptions {
  readonly keyPrefix?: string;
}

export class RedisConcurrencySlotsError extends Error {
  constructor(readonly code: 'REDIS_INVALID_SLOT_OPTIONS' | 'REDIS_INVALID_CACHE_OPTIONS') {
    super('invalid Redis hot-state configuration');
    this.name = 'RedisConcurrencySlotsError';
  }
}

export const REDIS_SLOT_SCRIPT = [
  'local member = ARGV[1]',
  'local max = tonumber(ARGV[2])',
  'local window = tonumber(ARGV[3])',
  'local ttl = tonumber(ARGV[4])',
  'if not member or not max or not window or not ttl then',
  '  return redis.error_reply("SLOT_STATE")',
  'end',
  'local t = redis.call("TIME")',
  'local now = t[1] * 1000 + math.floor(t[2] / 1000)',
  'redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now - window)',
  'local exists = redis.call("ZSCORE", KEYS[1], member)',
  'if (not exists) and redis.call("ZCARD", KEYS[1]) >= max then',
  '  return {0, now}',
  'end',
  'redis.call("ZADD", KEYS[1], now, member)',
  'redis.call("PEXPIRE", KEYS[1], ttl)',
  'return {1, now}',
].join('\n');

export const REDIS_SLOT_RELEASE_SCRIPT = ['redis.call("ZREM", KEYS[1], ARGV[1])', 'return 1'].join('\n');

export const REDIS_CACHE_GET_SCRIPT = 'return redis.call("GET", KEYS[1])';

export const REDIS_CACHE_SET_SCRIPT = ['redis.call("SET", KEYS[1], ARGV[1], "PX", tonumber(ARGV[2]))', 'return 1'].join(
  '\n',
);

/**
 * Sliding sticky read: GET + PEXPIRE in ONE atomic single-key script. The
 * refresh happens only when the key still exists (a miss touches nothing and
 * never resurrects an expired mapping). Single key by construction, so the
 * RESP client's EVAL allowlist (numkeys === '1') admits it as-is.
 */
export const REDIS_CACHE_GET_SLIDING_SCRIPT = [
  'local value = redis.call("GET", KEYS[1])',
  'if value then',
  '  local ttl = tonumber(ARGV[1])',
  '  if not ttl then return redis.error_reply("SLIDING_TTL_STATE") end',
  '  redis.call("PEXPIRE", KEYS[1], ttl)',
  'end',
  'return value',
].join('\n');

/**
 * Sticky-path clear (batch 2 §2.1 shouldClearStickySession): a single-key
 * DEL. A miss deletes nothing and never errors — clearing is idempotent.
 */
export const REDIS_CACHE_DELETE_SCRIPT = 'return redis.call("DEL", KEYS[1])';

export const REDIS_SLOT_DEFAULT_KEY_TTL_MS = 600_000;
/** Sticky mapping TTL: the plan's 1 hour, refreshed on every hit (idle bound). */
export const REDIS_STICKY_TTL_MS = 60 * 60_000;
/** Token-decrypt cache TTL: the plan's 60 seconds (rotation-bounded). */
export const REDIS_TOKEN_CACHE_TTL_MS = 60_000;
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 16_384;

function digestHex(domain: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256').update(domain);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}

function safeRedisString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return null;
  return Buffer.byteLength(value) > maxBytes ? null : value;
}

function validatePositiveInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** Slot key: the account dimension only (multi-dimension keys are additive). */
export function redisSlotKey(keyPrefix: string, ownerScopeKey: string, accountId: string): string | null {
  if (typeof keyPrefix !== 'string' || keyPrefix === '') return null;
  if (safeRedisString(ownerScopeKey, 256) === null || safeRedisString(accountId, 256) === null) return null;
  return `${keyPrefix}:concurrency-slot:v1:acct:${digestHex('model-router:slot:acct:v1', ownerScopeKey, accountId)}`;
}

/**
 * Sticky key: mr:sticky:{poolId}:{sessionHash} with the pool and reference
 * digested — the raw session reference never appears in the keyspace.
 */
export function redisStickyKey(keyPrefix: string, poolScopeKey: string, sessionHash: string): string | null {
  if (typeof keyPrefix !== 'string' || keyPrefix === '') return null;
  if (safeRedisString(poolScopeKey, 512) === null || safeRedisString(sessionHash, 512) === null) return null;
  return `${keyPrefix}:sticky:v1:${digestHex('model-router:sticky:v1', poolScopeKey, sessionHash)}`;
}

/** Token-decrypt cache key: the sealed envelope digest — rotation misses by construction. */
export function redisTokenCacheKey(keyPrefix: string, envelopeDigest: string): string | null {
  if (typeof keyPrefix !== 'string' || keyPrefix === '') return null;
  if (safeRedisString(envelopeDigest, 256) === null) return null;
  return `${keyPrefix}:token-cache:v1:${digestHex('model-router:token-cache:v1', envelopeDigest)}`;
}

/**
 * The sub2api sessionHash priority: session-id header → conversation_id →
 * prompt_cache_key → content-hash fallback. Returns the chosen reference
 * (null when none is present — no sticky fast path for the request).
 */
export function computeStickySessionHash(input: {
  readonly sessionId?: string | null;
  readonly conversationId?: string | null;
  readonly promptCacheKey?: string | null;
  readonly contentHash?: string | null;
}): string | null {
  for (const candidate of [input?.sessionId, input?.conversationId, input?.promptCacheKey, input?.contentHash]) {
    const value = safeRedisString(candidate, 512);
    if (value !== null) return value;
  }
  return null;
}

function replyToSlotDecision(reply: RedisRespValue): RedisConcurrencySlotDecision {
  if (!Array.isArray(reply) || reply.length !== 2) return { state: 'unavailable' };
  const allowed = reply[0];
  const now = reply[1];
  if (allowed !== 0 && allowed !== 1) return { state: 'unavailable' };
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) return { state: 'unavailable' };
  return allowed === 1 ? { state: 'acquired' } : { state: 'saturated' };
}

/** Creates the concurrency-slot client over one RESP connection; fail-open on any Redis error. */
export function createRedisConcurrencySlots(
  client: RedisHotStateClient,
  options: { readonly keyPrefix: string } = { keyPrefix: 'model-router:saas' },
): RedisConcurrencySlots {
  if (!client || typeof client.command !== 'function')
    throw new RedisConcurrencySlotsError('REDIS_INVALID_SLOT_OPTIONS');
  if (typeof options?.keyPrefix !== 'string' || options.keyPrefix === '' || options.keyPrefix.length > 128) {
    throw new RedisConcurrencySlotsError('REDIS_INVALID_SLOT_OPTIONS');
  }
  return {
    async tryAcquire(input) {
      try {
        const key = redisSlotKey(options.keyPrefix, input?.ownerScopeKey ?? '', input?.accountId ?? '');
        const maxSlots = validatePositiveInteger(input?.maxSlots, 1, 1_000_000);
        const windowMs = validatePositiveInteger(input?.windowMs, 1_000, 3_600_000);
        const member = safeRedisString(input?.requestId, 256);
        if (key === null || maxSlots === null || windowMs === null || member === null) {
          // Malformed input is a shape failure, not a Redis failure: treat it
          // as saturated so the caller falls back to the PG lease path.
          return { state: 'saturated' };
        }
        const reply = await client.command([
          'EVAL',
          REDIS_SLOT_SCRIPT,
          '1',
          key,
          member,
          String(maxSlots),
          String(windowMs),
          String(Math.max(windowMs * 2, REDIS_SLOT_DEFAULT_KEY_TTL_MS)),
        ]);
        const decision = replyToSlotDecision(reply);
        if (decision.state === 'unavailable' && typeof client.invalidate === 'function') {
          // A malformed reply poisons the connection rather than risking a
          // wrong admission decision on later commands; the caller still
          // fails open (the PG lease is the authority).
          try {
            client.invalidate('REDIS_PROTOCOL_ERROR');
          } catch {
            // invalidate throws by design — the decision below is already 'unavailable'.
          }
        }
        return decision;
      } catch {
        return { state: 'unavailable' };
      }
    },
    async release(input) {
      try {
        const key = redisSlotKey(options.keyPrefix, input?.ownerScopeKey ?? '', input?.accountId ?? '');
        const member = safeRedisString(input?.requestId, 256);
        if (key === null || member === null) return;
        await client.command(['EVAL', REDIS_SLOT_RELEASE_SCRIPT, '1', key, member]);
      } catch {
        // A lost release is self-healing: the member lazily expires via the
        // window and the key-level PEXPIRE.
      }
    },
  };
}

function replyToCacheEntry(reply: RedisRespValue): RedisCacheEntry {
  if (reply === null) return { state: 'miss', value: null };
  if (typeof reply === 'string') return { state: 'hit', value: Buffer.from(reply, 'base64') };
  if (Buffer.isBuffer(reply)) return { state: 'hit', value: Buffer.from(reply.toString('utf8'), 'base64') };
  return { state: 'unavailable', value: null };
}

/**
 * Creates the bounded runtime cache (sticky sessions, token-decrypt cache)
 * over one RESP connection; 'unavailable' on any Redis error (fail-open).
 */
export function createRedisRuntimeCache(
  client: RedisHotStateClient,
  options: RedisRuntimeCacheOptions = {},
): RedisRuntimeCache {
  if (!client || typeof client.command !== 'function')
    throw new RedisConcurrencySlotsError('REDIS_INVALID_CACHE_OPTIONS');
  const keyPrefix = options.keyPrefix ?? 'model-router:saas';
  if (typeof keyPrefix !== 'string' || keyPrefix === '' || keyPrefix.length > 128) {
    throw new RedisConcurrencySlotsError('REDIS_INVALID_CACHE_OPTIONS');
  }
  return {
    async get(key) {
      try {
        if (safeRedisString(key, MAX_KEY_BYTES) === null) return { state: 'miss', value: null };
        return replyToCacheEntry(await client.command(['EVAL', REDIS_CACHE_GET_SCRIPT, '1', key]));
      } catch {
        return { state: 'unavailable', value: null };
      }
    },
    async set(key, value, ttlMs) {
      try {
        if (safeRedisString(key, MAX_KEY_BYTES) === null) return;
        const ttl = validatePositiveInteger(ttlMs, 1, 86_400_000);
        if (ttl === null || !Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_VALUE_BYTES) return;
        await client.command(['EVAL', REDIS_CACHE_SET_SCRIPT, '1', key, value.toString('base64'), String(ttl)]);
      } catch {
        // Best-effort cache fill: a missed write is only a missed speedup.
      }
    },
    async getAndRefreshTtl(key, ttlMs) {
      try {
        if (safeRedisString(key, MAX_KEY_BYTES) === null) return { state: 'miss', value: null };
        const ttl = validatePositiveInteger(ttlMs, 1, 86_400_000);
        if (ttl === null) return { state: 'miss', value: null };
        return replyToCacheEntry(await client.command(['EVAL', REDIS_CACHE_GET_SLIDING_SCRIPT, '1', key, String(ttl)]));
      } catch {
        // Same fail-open posture as get/set: an unavailable Redis only costs
        // the sticky fast path, never the request.
        return { state: 'unavailable', value: null };
      }
    },
    async delete(key) {
      try {
        if (safeRedisString(key, MAX_KEY_BYTES) === null) return;
        await client.command(['EVAL', REDIS_CACHE_DELETE_SCRIPT, '1', key]);
      } catch {
        // Best-effort clear: a stale row is re-checked against eligibility
        // on every read and PG re-decides, so a failed delete is harmless.
      }
    },
  };
}

/** Computes the sticky fast-path key for one request scope, or null when no reference exists. */
export function stickyKeyForRequest(
  keyPrefix: string,
  poolScopeKey: string,
  references: {
    readonly sessionId?: string | null;
    readonly conversationId?: string | null;
    readonly promptCacheKey?: string | null;
    readonly contentHash?: string | null;
  },
): string | null {
  const sessionHash = computeStickySessionHash(references);
  if (sessionHash === null) return null;
  return redisStickyKey(keyPrefix, poolScopeKey, sessionHash);
}

/** Computes the token-decrypt cache key from the sealed envelope material. */
export function tokenCacheKeyForEnvelope(
  keyPrefix: string,
  envelope: {
    readonly kmsKeyId: string;
    readonly wrappedDek: string;
    readonly nonce: string;
    readonly ciphertext: string;
    readonly authTag: string;
  },
): string | null {
  return redisTokenCacheKey(
    keyPrefix,
    digestHex(
      'model-router:envelope:v1',
      envelope.kmsKeyId,
      envelope.wrappedDek,
      envelope.nonce,
      envelope.ciphertext,
      envelope.authTag,
    ),
  );
}
