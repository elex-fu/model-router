import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@redis/client';

export interface QuotaStateRow {
  key: string;
  value: unknown;
  version: number;
}
export interface QuotaStateBatch {
  generation: number;
  version: number;
  rows: QuotaStateRow[];
}
/** All gateway instances using a namespace must share this durable store. */
export interface QuotaStatePersistence {
  identity(): Promise<string>;
  generation(): Promise<number>;
  beginGeneration(expected: number): Promise<number>;
  load(keys: string[]): Promise<QuotaStateRow[]>;
  apply(batches: QuotaStateBatch[]): Promise<void>;
  ping(generation?: number): Promise<void>;
  expiredRequests?(nowMs: number, limit: number): Promise<string[]>;
}

const BOOTSTRAP = `
local current=redis.call('HGET',KEYS[1],'identity')
if current and current~=ARGV[1] then return -1 end
if current and redis.call('HGET',KEYS[1],'runId')==ARGV[4] then
  return tonumber(redis.call('HGET',KEYS[1],'generation'))
end
if redis.call('GET',KEYS[2])~=ARGV[3] then return redis.error_reply('QUOTA_BOOTSTRAP_LEASE_LOST') end
redis.call('DEL',KEYS[1])
redis.call('HSET',KEYS[1],'identity',ARGV[1],'generation',ARGV[2],'runId',ARGV[4],'revision',0,'persisted',0,'healthyUntil',0)
return tonumber(ARGV[2])`;

// A mutation and its write-behind record are ONE HSET. A Redis script does not
// roll back earlier commands on a runtime error, so no writes happen before
// validation and computation have both finished. The hash has one cluster slot.
const MUTATION_PREFIX = `
local input=cjson.decode(ARGV[1])
local keys=cjson.decode(ARGV[2])
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if redis.call('HEXISTS',KEYS[1],'generation')==0 then return cjson.encode({uninitialized=true}) end
if redis.call('HGET',KEYS[1],'runId')~=ARGV[4] then return cjson.encode({uninitialized=true}) end
local revision=tonumber(redis.call('HGET',KEYS[1],'revision'))
local persisted=tonumber(redis.call('HGET',KEYS[1],'persisted'))
local healthy=tonumber(redis.call('HGET',KEYS[1],'healthyUntil') or '0')
if input.admission and (healthy<now or revision-persisted>=tonumber(ARGV[3])) then
  return cjson.encode({result={allowed=false,reason='quota_unavailable'}})
end
local missing={}
local state={}
for _,key in ipairs(keys) do
  local raw=redis.call('HGET',KEYS[1],'s:'..key)
  if not raw then
    if input.freshKey==key then state[key]=cjson.null else table.insert(missing,key) end
  else state[key]=cjson.decode(raw).value end
end
if #missing>0 then return cjson.encode({missing=missing}) end
local changes={}
local function read(key) return state[key] end
local function save(key,value) changes[key]=value; state[key]=value end
local function run()
`;
const MUTATION_SUFFIX = `
end
local result=run()
if next(changes) then
  revision=revision+1
  local fields={'revision',tostring(revision)}
  local rows={}
  for key,value in pairs(changes) do
    local row={key=key,value=value,version=revision}
    table.insert(rows,row)
    table.insert(fields,'s:'..key)
    table.insert(fields,cjson.encode(row))
  end
  local event={generation=tonumber(redis.call('HGET',KEYS[1],'generation')),version=revision,rows=rows}
  table.insert(fields,'e:'..revision)
  table.insert(fields,cjson.encode(event))
  redis.call('HSET',KEYS[1],unpack(fields))
end
-- Keep read-through absence sentinels. Deleting an empty scope on rejection
-- makes concurrent cold admissions repeatedly erase one another's hydration.
-- Fresh request UUIDs bypass read-through and do not create negative entries.
return cjson.encode({result=result})`;

const BACKFILL = `
if redis.call('HGET',KEYS[1],'generation')~=ARGV[1] then return 0 end
-- The revision fence prevents a slow DB read from overwriting a newly
-- persisted-and-evicted value, even when the cache is empty again.
if tonumber(redis.call('HGET',KEYS[1],'evictedRevision') or '0')>tonumber(ARGV[2]) then return 0 end
local fields={}
for _,row in ipairs(cjson.decode(ARGV[3])) do
  if redis.call('HEXISTS',KEYS[1],'s:'..row.key)==0 then
    row.version=0
    table.insert(fields,'s:'..row.key)
    table.insert(fields,cjson.encode(row))
  end
end
if #fields>0 then redis.call('HSET',KEYS[1],unpack(fields)) end
return 1`;

const CLAIM = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local untilMs=tonumber(redis.call('HGET',KEYS[1],'leaseUntil') or '0')
local owner=redis.call('HGET',KEYS[1],'leaseOwner')
if owner and owner~=ARGV[1] and untilMs>now then return '{}' end
local generation=tonumber(redis.call('HGET',KEYS[1],'generation'))
if not generation then return '{}' end
redis.call('HSET',KEYS[1],'leaseOwner',ARGV[1],'leaseUntil',now+tonumber(ARGV[2]))
local head=tonumber(redis.call('HGET',KEYS[1],'persisted'))
local tail=tonumber(redis.call('HGET',KEYS[1],'revision'))
local events={}
for i=head+1,math.min(tail,head+tonumber(ARGV[3])) do
  local event=redis.call('HGET',KEYS[1],'e:'..i)
  if not event then return redis.error_reply('QUOTA_JOURNAL_GAP') end
  table.insert(events,cjson.decode(event))
end
return cjson.encode({generation=generation,events=events})`;

const ACK = `
if redis.call('HGET',KEYS[1],'leaseOwner')~=ARGV[1] or redis.call('HGET',KEYS[1],'generation')~=ARGV[2] then return 0 end
local head=tonumber(redis.call('HGET',KEYS[1],'persisted'))
local target=tonumber(ARGV[3])
local remove={}
for i=head+1,target do
  local raw=redis.call('HGET',KEYS[1],'e:'..i)
  if raw then
    table.insert(remove,'e:'..i)
    -- Terminal per-request entries live durably in the DB; removing their
    -- clean cache values bounds Redis memory without deleting idempotency.
    for _,row in ipairs(cjson.decode(raw).rows) do
      if type(row.value)=='table' and row.value.evictAfterPersist then
        local current=redis.call('HGET',KEYS[1],'s:'..row.key)
        if current and cjson.decode(current).version==row.version then table.insert(remove,'s:'..row.key) end
      end
    end
  end
end
if #remove>0 then
  redis.call('HDEL',KEYS[1],unpack(remove))
  redis.call('HSET',KEYS[1],'evictedRevision',redis.call('HGET',KEYS[1],'revision'))
end
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
redis.call('HSET',KEYS[1],'persisted',target,'healthyUntil',now+tonumber(ARGV[4]),'leaseUntil',now+math.min(500,tonumber(ARGV[4])/2))
return 1`;

export interface RedisQuotaStateOptions {
  url: string;
  namespace: string;
  persistence: QuotaStatePersistence;
  flushIntervalMs?: number;
  maxPending?: number;
  healthTtlMs?: number;
  /** Tests and separately deployed persistence workers may start it explicitly. */
  background?: boolean;
}

async function boundedPersistence<T>(operation: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quota persistence timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared atomic hot state plus a replayable, fenced DB write-behind journal. */
export class RedisQuotaState {
  private readonly redis;
  private readonly redisKey: string;
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private draining?: Promise<boolean>;
  private closed = false;
  private generation = 0;
  private identity = '';
  private runId = '';
  private connectionEpoch = 0;
  private initializedEpoch = -1;
  private initializing?: Promise<void>;

  private constructor(private readonly options: RedisQuotaStateOptions) {
    if (!options.namespace || options.namespace.length > 200) throw new Error('Invalid quota namespace');
    for (const value of [options.flushIntervalMs ?? 100, options.maxPending ?? 10000, options.healthTtlMs ?? 2000])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid quota queue bounds');
    this.redisKey = `mr:quota:{${createHash('sha256').update(options.namespace).digest('hex')}}`;
    this.redis = createClient({
      url: options.url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 4096,
      socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(1000, 100 + retries * 100) },
    });
    // Availability is surfaced by bounded commands/health; never print URLs or
    // raw driver errors (they may contain credentials).
    this.redis.on('error', () => {});
    this.redis.on('ready', () => {
      this.connectionEpoch++;
    });
  }

  static async open(options: RedisQuotaStateOptions): Promise<RedisQuotaState> {
    const store = new RedisQuotaState(options);
    let connectTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        store.redis.connect(),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(() => reject(new Error('Quota Redis connection timed out')), 2500);
        }),
      ]);
      clearTimeout(connectTimer);
      store.identity = await boundedPersistence(options.persistence.identity());
      await store.ensureInitialized();
      await store.flushOnce();
      if (options.background !== false) {
        store.timer = setInterval(() => void store.flushOnce().catch(() => {}), options.flushIntervalMs ?? 100);
        store.timer.unref();
      }
      return store;
    } catch {
      clearTimeout(connectTimer);
      if (store.redis.isOpen) store.redis.destroy();
      throw new Error('Shared quota store unavailable');
    }
  }

  private async eval(script: string, args: string[]): Promise<unknown> {
    if (this.closed) throw new Error('Shared quota store closed');
    await this.ensureInitialized();
    return this.redis
      .withCommandOptions({ abortSignal: AbortSignal.timeout(2000) })
      .eval(script, { keys: [this.redisKey], arguments: args });
  }

  private commands() {
    return this.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(2000) });
  }

  private async ensureInitialized(): Promise<void> {
    while (this.initializedEpoch !== this.connectionEpoch) {
      if (!this.initializing) {
        const epoch = this.connectionEpoch;
        this.initializing = (async () => {
          const info = await this.commands().info('server');
          const runId = /^run_id:(\w+)\r?$/m.exec(info)?.[1];
          if (!runId) throw new Error('Quota Redis process identity unavailable');
          this.runId = runId;
          await this.initialize();
          this.initializedEpoch = epoch;
        })().finally(() => {
          this.initializing = undefined;
        });
      }
      await this.initializing;
    }
  }

  private async initialize(): Promise<void> {
    // Read the durable fence before checking/acquiring Redis bootstrap state.
    // A late initializer can never increment beyond a newer winner's epoch.
    const expectedGeneration = await boundedPersistence(this.options.persistence.generation());
    const existing = await this.commands().hmGet(this.redisKey, ['identity', 'generation', 'runId']);
    if (existing[0]) {
      if (existing[0] !== this.identity) throw new Error('Quota instances do not share the same database');
      if (existing[2] === this.runId) {
        this.generation = Number(existing[1]);
        return;
      }
    }
    // A separate bootstrap lease protects the durable generation fence. It is
    // never used for per-request admission and is safe across gateway restarts.
    const lockKey = `${this.redisKey}:bootstrap`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.commands().set(lockKey, this.owner, { NX: true, PX: 10000 })) {
        try {
          const raced = await this.commands().hmGet(this.redisKey, ['identity', 'generation', 'runId']);
          if (raced[0] && raced[0] !== this.identity) throw new Error('Quota database identity mismatch');
          // Redis may restore an AOF/RDB older than an already committed SQL
          // write. A new server process always starts a fenced generation and
          // hydrates SQL, never trusting the restored cache as newer evidence.
          const generation =
            raced[0] && raced[2] === this.runId
              ? Number(raced[1])
              : await boundedPersistence(this.options.persistence.beginGeneration(expectedGeneration));
          const value = Number(
            await this.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(2000) }).eval(BOOTSTRAP, {
              keys: [this.redisKey, lockKey],
              arguments: [this.identity, String(generation), this.owner, this.runId],
            }),
          );
          if (value < 1) throw new Error('Quota database identity mismatch');
          this.generation = value;
          return;
        } finally {
          await this.commands().eval(
            "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
            {
              keys: [lockKey],
              arguments: [this.owner],
            },
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const raced = await this.commands().hmGet(this.redisKey, ['identity', 'generation', 'runId']);
      if (raced[0]) {
        if (raced[0] !== this.identity) throw new Error('Quota database identity mismatch');
        if (raced[2] === this.runId) {
          this.generation = Number(raced[1]);
          return;
        }
      }
    }
    throw new Error('Quota initialization timed out');
  }

  async mutate<T>(keys: string[], script: string, input: unknown): Promise<T> {
    const serialized = JSON.stringify(input);
    if (keys.length < 1 || keys.length > 32 || keys.some((key) => key.length > 512) || serialized.length > 65536)
      throw new Error('Quota operation exceeds bounds');
    for (let attempt = 0; attempt < 10; attempt++) {
      const reply = JSON.parse(
        String(
          await this.eval(MUTATION_PREFIX + script + MUTATION_SUFFIX, [
            serialized,
            JSON.stringify(keys),
            String(this.options.maxPending ?? 10000),
            this.runId,
          ]),
        ),
      ) as { missing?: string[]; uninitialized?: boolean; result: T };
      if (reply.uninitialized) {
        await this.initialize();
        await this.flushOnce();
        continue;
      }
      if (!reply.missing) return reply.result;
      const fence = await this.commands().hmGet(this.redisKey, ['generation', 'revision']);
      if (!fence[0]) {
        await this.initialize();
        await this.flushOnce();
        continue;
      }
      const loaded = await boundedPersistence(this.options.persistence.load(reply.missing));
      const rows = reply.missing.map(
        (key) => loaded.find((row) => row.key === key) ?? { key, value: null, version: 0 },
      );
      await this.eval(BACKFILL, [fence[0], fence[1] ?? '0', JSON.stringify(rows)]);
    }
    throw new Error('Quota cache hydration could not converge');
  }

  async read<T>(key: string): Promise<T | null> {
    return this.mutate([key], 'return read(keys[1])', {});
  }

  async status(): Promise<{ pending: number; healthy: boolean }> {
    const result = await this.eval(
      `
      local clock=redis.call('TIME')
      local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
      return {tonumber(redis.call('HGET',KEYS[1],'revision') or '0')-tonumber(redis.call('HGET',KEYS[1],'persisted') or '0'),
      tonumber(redis.call('HGET',KEYS[1],'healthyUntil') or '0')>now and 1 or 0}`,
      [],
    );
    const values = result as number[];
    return { pending: values[0] ?? 0, healthy: values[1] === 1 };
  }

  flushOnce(): Promise<boolean> {
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<boolean> {
    if (this.closed) return false;
    const claim = JSON.parse(String(await this.eval(CLAIM, [this.owner, '10000', '100']))) as {
      generation?: number;
      events?: QuotaStateBatch[] | Record<string, never>;
    };
    if (!claim.generation) return false;
    const events = Array.isArray(claim.events) ? claim.events : [];
    try {
      if (events.length) await boundedPersistence(this.options.persistence.apply(events));
      else await boundedPersistence(this.options.persistence.ping(claim.generation));
      const head = events.at(-1)?.version ?? Number(await this.commands().hGet(this.redisKey, 'persisted'));
      await this.eval(ACK, [
        this.owner,
        String(claim.generation),
        String(head),
        String(this.options.healthTtlMs ?? 2000),
      ]);
      return events.length > 0;
    } catch {
      await this.eval(
        `if redis.call('HGET',KEYS[1],'leaseOwner')==ARGV[1] then
        redis.call('HSET',KEYS[1],'healthyUntil',0,'leaseUntil',0) end return 0`,
        [this.owner],
      ).catch(() => {});
      throw new Error('Quota persistence unavailable; new admissions paused');
    }
  }

  async flush(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await boundedPersistence(this.flushOnce(), Math.max(1, deadline - Date.now()));
      if ((await this.status()).pending === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Quota persistence drain timed out');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    clearInterval(this.timer);
    try {
      await this.flush();
    } finally {
      this.closed = true;
      if (this.redis.isOpen) this.redis.destroy();
    }
  }
}
