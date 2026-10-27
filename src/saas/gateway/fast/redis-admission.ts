import { createHash, createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClient } from '@redis/client';
import { createRedisScriptTransport } from './redis-script-transport.js';

/** Redis is the authority in this opt-in path, NOT a pre-check for a PG lease. */
export interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
export interface FastLimit {
  readonly rpm?: number | null;
  readonly tpm?: number | null;
  readonly concurrency?: number | null;
  /** Conservative trailing window, at most one additional second; never a fixed-window reset. */
  readonly rateWindowMs?: number;
}
export interface FastAdmissionInput {
  readonly requestId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly userId?: string;
  readonly groupId?: string;
  readonly accountId: string;
  /** 'platform' is global; a private account uses its owning tenant's canonical ID. */
  readonly accountOwnerScope: string;
  readonly model?: string;
  readonly tokenUnits: number;
  readonly limits: {
    readonly tenant?: FastLimit;
    readonly project?: FastLimit;
    readonly key?: FastLimit;
    readonly user?: FastLimit;
    readonly group?: FastLimit;
    readonly account?: FastLimit;
  };
  /** Enforced upper bound on upstream lifetime, not the HTTP client's lifetime. */
  readonly ttlMs: number;
  /** Preserve this token when retrying a lost ACK across callers/processes. */
  readonly acquisitionToken?: string;
}
export interface FastAdmissionLease {
  readonly fencingToken: string;
  readonly renewIntervalMs: number;
  assertValid(): Promise<boolean>;
  renew(): Promise<void>;
  /** Call ONLY once upstream has actually finished/acknowledged cancellation. Never on client close alone. */
  release(feedback?: FastAdmissionFeedback): Promise<void>;
  /**
   * Release only the upstream concurrency permit, preserving the reserved TPM.
   * Call only after upstream completion/cancellation, never client close alone.
   * Optional for adapters that do not support detached durable receipt delivery.
   */
  releaseConcurrency?(feedback?: FastAdmissionFeedback): Promise<void>;
  /**
   * Reconcile the original TPM reservation ONLY after a durable, validated
   * successful receipt ACK. Does not release concurrency. Retry the SAME actual
   * after an uncertain ACK; conflicting usage is rejected. No RPM refund.
   * May complete without writing when Redis TIME proves the original bucket
   * expired, with a valid authority sentinel and no conflicting incarnation.
   */
  reconcileDurableUsage?(actualTokenUnits: number): Promise<void>;
}
export type FastAdmissionResult =
  | {
      readonly allowed: false;
      readonly reason: 'rate_limited' | 'quota_exceeded' | 'unavailable';
      readonly retryAfterMs?: number;
    }
  | { readonly allowed: true; readonly lease: FastAdmissionLease };
export interface FastAdmissionFeedback {
  readonly outcome: 'success' | 'failure' | 'rate_limited';
  readonly cooldownMs?: number;
  /** A model-specific throttle must not suppress the entire account. */
  readonly modelOnly?: boolean;
  /** Exact input+output total, only after a durable validated successful usage receipt. */
  readonly actualTokenUnits?: number;
}
export interface FastGatewayAdmission {
  acquire(input: FastAdmissionInput): Promise<FastAdmissionResult>;
}
export interface RedisFastAdmissionOptions {
  readonly redis: RedisEvalClient;
  readonly namespace: string;
  /** Redis INFO server run_id, verified at connection bootstrap. */
  readonly runId: string;
  readonly maxTtlMs: number;
  readonly abortGraceMs?: number;
  readonly renewIntervalMs?: number;
  readonly replayRetentionMs?: number;
}

const CLOCK = `local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
`;
const INITIALIZE = `${CLOCK}
local old=redis.call('GET',KEYS[1])
if old then
  local m=cjson.decode(old)
  if m.runId==ARGV[1] then
    if m.horizon~=tonumber(ARGV[2]) then return cjson.encode({ok=false}) end
    return cjson.encode({ok=true,readyInMs=math.max(0,m.readyAt-now)})
  end
end
local wait=ARGV[3]=='drained' and 0 or tonumber(ARGV[2])
redis.call('SET',KEYS[1],cjson.encode({runId=ARGV[1],horizon=tonumber(ARGV[2]),readyAt=now+wait}))
return cjson.encode({ok=true,readyInMs=wait})`;
const CHECK_READY = `${CLOCK}
local raw=redis.call('GET',KEYS[1])
if not raw then return cjson.encode({ok=false}) end
local meta=cjson.decode(raw)
return cjson.encode({ok=meta.runId==ARGV[1] and meta.horizon==tonumber(ARGV[2]) and type(meta.readyAt)=='number' and meta.readyAt<=now})`;
const PREFIX = `${CLOCK}
local p=cjson.decode(ARGV[1])
local rawMeta=redis.call('GET',KEYS[1])
if not rawMeta then return cjson.encode({ok=false,reason='unavailable'}) end
local meta=cjson.decode(rawMeta)
if type(meta.runId)~='string' or meta.runId=='' or meta.horizon~=p.horizon or type(meta.readyAt)~='number' or meta.readyAt<0 then return cjson.encode({ok=false,reason='unavailable'}) end
-- Expired usage may be proved irrelevant under a newer valid generation, but
-- no lease mutation or admission may cross the run-id authority boundary.
if meta.runId~=p.runId and p.operation~='usage' then return cjson.encode({ok=false,reason='unavailable'}) end
local raw=redis.call('GET',KEYS[2])
local record=raw and cjson.decode(raw) or nil
local function reply(r)
  return cjson.encode({ok=true,untilMs=r.untilMs,renewInMs=math.max(0,r.renewBy-now),token=r.token,incarnation=r.incarnation,bucket=r.bucket})
end
local function matches(r)
  return r and r.token==p.token and r.binding==p.binding and r.runId==p.runId
end
local function owns(r)
  return matches(r) and r.incarnation==p.incarnation
end
`;
const ACQUIRE = `${PREFIX}
if meta.readyAt>now then return cjson.encode({ok=false,reason='unavailable',retryAfterMs=meta.readyAt-now}) end
if record then
  -- Pre-incarnation records cannot safely authorize a new process or delayed
  -- feedback. A rolling upgrade retains their reservations until normal expiry.
  if not matches(record) or type(record.incarnation)~='string' or record.state~='active' or record.renewBy<=now then return cjson.encode({ok=false,reason='unavailable'}) end
  return reply(record)
end
for i=3,4 do
  local rawHealth=redis.call('GET',KEYS[i])
  if rawHealth then
    local health=cjson.decode(rawHealth)
    if health.untilMs>now then return cjson.encode({ok=false,reason='rate_limited',retryAfterMs=health.untilMs-now}) end
  end
end
local rates={}
for i,limit in ipairs(p.limits) do
  local slotKey=KEYS[3+i*2]
  local rateKey=KEYS[4+i*2]
  if limit.concurrency>0 then
    local kind=redis.call('TYPE',slotKey).ok
    if kind~='none' and kind~='zset' then return redis.error_reply('FAST_ADMISSION_STATE') end
    -- Expired members can be cleaned before a rejected admission; this is not a reservation.
    redis.call('ZREMRANGEBYSCORE',slotKey,'-inf',now)
    if redis.call('ZCARD',slotKey)>=limit.concurrency then return cjson.encode({ok=false,reason='rate_limited'}) end
  end
  local rawRate=redis.call('GET',rateKey)
  local rate=rawRate and cjson.decode(rawRate) or {buckets={}}
  local requests=0; local tokens=0
  for bucket,counts in pairs(rate.buckets) do
    local endMs=tonumber(bucket)*1000+1000
    if endMs<=now-60000 then rate.buckets[bucket]=nil
    elseif endMs>now-limit.window then requests=requests+counts[1]; tokens=tokens+counts[2] end
  end
  if limit.rpm>0 and requests+1>limit.rpm then return cjson.encode({ok=false,reason='rate_limited'}) end
  if limit.tpm>0 and tokens+p.tokenUnits>limit.tpm then return cjson.encode({ok=false,reason='quota_exceeded'}) end
  if requests>9000000000000000-1 or tokens>9000000000000000-p.tokenUnits then return cjson.encode({ok=false,reason='unavailable'}) end
  rates[i]=rate
end
-- Dispatch may begin just before renewBy and then consume the full upstream TTL.
record={token=p.token,binding=p.binding,runId=p.runId,incarnation=p.incarnation,state='active',untilMs=now+p.renew+p.ttl+p.grace,renewBy=now+p.renew,bucket=tostring(math.floor(now/1000)),tokenUnits=p.tokenUnits}
local encoded=cjson.encode(record)
for i,limit in ipairs(p.limits) do
  if limit.rpm>0 or limit.tpm>0 then
    local rate=rates[i]
    local bucket=tostring(math.floor(now/1000))
    local counts=rate.buckets[bucket] or {0,0}
    counts[1]=counts[1]+1; counts[2]=counts[2]+p.tokenUnits; rate.buckets[bucket]=counts
    redis.call('SET',KEYS[4+i*2],cjson.encode(rate),'PX',61000)
  end
  if limit.concurrency>0 then
    redis.call('ZADD',KEYS[3+i*2],record.untilMs,p.member)
    -- A shared key must never expire before another member with a longer lease.
    local latest=redis.call('ZRANGE',KEYS[3+i*2],-1,-1,'WITHSCORES')
    redis.call('PEXPIREAT',KEYS[3+i*2],math.ceil(tonumber(latest[2])))
  end
end
-- Last mutation is the receipt. Any preceding command failure only over-reserves;
-- the caller fails closed and MUST NOT dispatch without this acknowledged receipt.
redis.call('SET',KEYS[2],encoded,'PX',p.renew+p.ttl+p.grace+p.retention)
return reply(record)`;
const RENEW = `${PREFIX}
if not owns(record) or record.state~='active' or record.renewBy<=now then return cjson.encode({ok=false,reason='unavailable'}) end
for i,limit in ipairs(p.limits) do
  if limit.concurrency>0 then
    local score=redis.call('ZSCORE',KEYS[3+i*2],p.member)
    if not score or tonumber(score)<=now then return cjson.encode({ok=false,reason='unavailable'}) end
  end
end
record.untilMs=now+p.renew+p.ttl+p.grace; record.renewBy=now+p.renew
for i,limit in ipairs(p.limits) do
  if limit.concurrency>0 then
    redis.call('ZADD',KEYS[3+i*2],'XX',record.untilMs,p.member)
    local latest=redis.call('ZRANGE',KEYS[3+i*2],-1,-1,'WITHSCORES')
    redis.call('PEXPIREAT',KEYS[3+i*2],math.ceil(tonumber(latest[2])))
  end
end
redis.call('SET',KEYS[2],cjson.encode(record),'PX',p.renew+p.ttl+p.grace+p.retention)
return reply(record)`;
const RELEASE = `${PREFIX}
local mode=p.operation
if mode~='legacy' and mode~='concurrency' and mode~='usage' then return redis.error_reply('FAST_ADMISSION_STATE') end
local feedback=p.feedback
local actual=feedback and feedback.actualTokenUnits
if mode=='concurrency' and actual~=nil then return redis.error_reply('FAST_ADMISSION_USAGE') end
if mode=='usage' and actual==nil then return redis.error_reply('FAST_ADMISSION_USAGE') end
if actual~=nil and (feedback.outcome~='success' or type(actual)~='number' or actual<0 or actual>p.tokenUnits or actual~=math.floor(actual)) then
  return redis.error_reply('FAST_ADMISSION_USAGE')
end
if mode=='usage' then
  -- The canonical bucket comes from the original acknowledged admission, not
  -- a caller clock/TTL estimate. This is a terminal NO-WRITE result: a bucket
  -- outside the longest supported rate window can no longer need a refund.
  local bucket=tonumber(p.admissionBucket)
  if bucket and bucket>=0 and bucket==math.floor(bucket) and bucket*1000+1000<=now-60000 then
    if record then
      if not owns(record) or (record.state~='active' and record.state~='released') then return cjson.encode({ok=false,reason='unavailable'}) end
      if record.usageState=='settled' and record.actualTokenUnits~=actual then return redis.error_reply('FAST_ADMISSION_USAGE') end
    end
    return cjson.encode({ok=true,usageExpired=true})
  end
end
if meta.runId~=p.runId or not owns(record) then return cjson.encode({ok=false,reason='unavailable'}) end
if record.state~='active' and record.state~='released' then return redis.error_reply('FAST_ADMISSION_STATE') end
-- Preserve the legacy one-shot release contract, including no late feedback.
if mode~='usage' and record.state=='released' then return cjson.encode({ok=true}) end
if mode=='usage' then
  if record.usageState=='settled' then
    if record.actualTokenUnits~=actual then return redis.error_reply('FAST_ADMISSION_USAGE') end
    return cjson.encode({ok=true})
  end
  -- Released old/default-mode records never attest to an outstanding refund.
  if record.usageState=='closed' or (record.state=='released' and record.usageState~='pending') then return cjson.encode({ok=true}) end
end
local writes={}; local expiries={}
-- Only a validated, durable successful receipt can reconcile the original
-- reservation. Old-version receipts without immutable bucket facts retain it.
if actual~=nil and record.usageState~='settled' and record.usageState~='closed' then
  if record.bucket and record.tokenUnits==p.tokenUnits then
    local refund=record.tokenUnits-actual
    for i,limit in ipairs(p.limits) do
      if refund>0 and (limit.rpm>0 or limit.tpm>0) then
        local key=KEYS[4+i*2]
        local rawRate=redis.call('GET',key)
        if rawRate then
          local rate=cjson.decode(rawRate)
          local counts=rate.buckets[record.bucket]
          -- Never subtract from a newer bucket when the admission bucket expired.
          if counts and tonumber(record.bucket)*1000+1000>now-60000 then
            if type(counts[1])~='number' or counts[1]<1 or type(counts[2])~='number' or counts[2]<refund then
              return redis.error_reply('FAST_ADMISSION_STATE')
            end
            counts[2]=counts[2]-refund
            table.insert(writes,key); table.insert(writes,cjson.encode(rate))
            table.insert(expiries,key)
          end
        end
      end
    end
  end
  record.usageState='settled'; record.actualTokenUnits=actual
end
if mode~='usage' then
  -- Feedback is monotone: a late success cannot erase another request's cooldown.
  if feedback and feedback.outcome~='success' and feedback.cooldownMs>0 then
    local index=feedback.modelOnly and 4 or 3
    local rawHealth=redis.call('GET',KEYS[index])
    local health=rawHealth and cjson.decode(rawHealth) or {untilMs=0}
    local untilMs=math.max(health.untilMs,now+feedback.cooldownMs)
    redis.call('SET',KEYS[index],cjson.encode({untilMs=untilMs}),'PX',math.ceil(untilMs-now))
  end
  for i,limit in ipairs(p.limits) do
    if limit.concurrency>0 then redis.call('ZREM',KEYS[3+i*2],p.member) end
  end
  record.state='released'
  if not record.usageState then record.usageState=mode=='concurrency' and 'pending' or 'closed' end
end
-- Reconciliation may precede release/renew. Never shorten an active lease's
-- replay horizon, and retain a pending split tombstone through its rate bucket.
local expiresAt=math.max(now,record.state=='active' and record.untilMs or now)+p.retention
if record.usageState=='pending' and record.bucket then
  expiresAt=math.max(expiresAt,tonumber(record.bucket)*1000+61000)
end
if #writes==0 then
  redis.call('SET',KEYS[2],cjson.encode(record),'PX',math.ceil(expiresAt-now))
else
  -- Lua errors do not roll back prior commands. Counter reconciliation and the
  -- once-only tombstone MUST be one atomic Redis command, not successive SETs.
  table.insert(writes,KEYS[2]); table.insert(writes,cjson.encode(record))
  redis.call('MSET',unpack(writes))
  -- MSET clears TTL. A later expiry failure may retain keys, but the tombstone
  -- already prevents a retry from decrementing any token counter again.
  for _,key in ipairs(expiries) do redis.call('PEXPIREAT',key,math.ceil(now+61000)) end
  redis.call('PEXPIREAT',KEYS[2],math.ceil(expiresAt))
end
return cjson.encode({ok=true})`;

type Decision = {
  ok: boolean;
  reason?: 'rate_limited' | 'quota_exceeded' | 'unavailable';
  token?: string;
  incarnation?: string;
  bucket?: string;
  renewInMs?: number;
  readyInMs?: number;
  retryAfterMs?: number;
};
const digest = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
}
function decode(reply: unknown): Decision {
  if (typeof reply !== 'string') throw new Error('Fast admission unavailable');
  const result = JSON.parse(reply) as Decision;
  if (typeof result?.ok !== 'boolean') throw new Error('Fast admission unavailable');
  return result;
}
/**
 * Separate lexical scope from acquire/release/renew: a detached queue retains
 * only this rate capability, not lifecycle promises or request async contexts.
 * Command parameters/keys are immutable serialized scalar snapshots.
 */
function durableUsageReconciler(
  redis: RedisEvalClient,
  keys: readonly string[],
  serializedParameters: string,
  reservedTokenUnits: number,
): (actualTokenUnits: number) => Promise<void> {
  const commandKeys = [...keys];
  const argumentPrefix = serializedParameters.slice(0, -1);
  let reconciling: Promise<void> | undefined;
  let reconciliationTokenUnits: number | undefined;
  return (actualTokenUnits) => {
    if (
      !integer(actualTokenUnits, 0, reservedTokenUnits) ||
      (reconciliationTokenUnits !== undefined && reconciliationTokenUnits !== actualTokenUnits)
    )
      return Promise.reject(new Error('Invalid fast admission durable usage'));
    if (reconciling) return reconciling;
    reconciliationTokenUnits = actualTokenUnits;
    reconciling = redis
      .eval(RELEASE, {
        keys: commandKeys,
        arguments: [
          `${argumentPrefix},"operation":"usage","feedback":{"outcome":"success","actualTokenUnits":${actualTokenUnits},"cooldownMs":0}}`,
        ],
      })
      .then((raw) => {
        if (!decode(raw).ok) throw new Error('Fast admission usage reconciliation unavailable');
      })
      .catch(() => {
        reconciling = undefined;
        throw new Error('Fast admission usage reconciliation unavailable');
      });
    return reconciling;
  };
}
function normalize(limit: FastLimit | undefined) {
  const value = {
    rpm: limit?.rpm ?? 0,
    tpm: limit?.tpm ?? 0,
    concurrency: limit?.concurrency ?? 0,
    window: limit?.rateWindowMs ?? 60000,
  };
  if (
    !integer(value.rpm, 0, 1_000_000_000) ||
    !integer(value.tpm, 0, 1_000_000_000_000) ||
    !integer(value.concurrency, 0, 1_000_000) ||
    !integer(value.window, 1, 60000)
  )
    throw new Error('Invalid fast admission limits');
  return value;
}

/**
 * All dimensions deliberately share ONE Redis hash slot. Platform supply is global,
 * not tenant-sharded. No Redis Cluster client/failover/replica-read support is claimed.
 * Redis must use noeviction; missing state or a lost connection fails closed.
 * Pre-split binaries cannot take over these versioned lease bindings (or vice
 * versa). Drain old instances normally; never clear authority to speed rollout.
 */
export class RedisFastGatewayAdmission implements FastGatewayAdmission {
  private readonly prefix: string;
  private readonly secret = randomBytes(32);
  private readonly grace: number;
  private readonly renewEvery: number;
  private readonly retention: number;
  private readonly horizon: number;
  constructor(private readonly options: RedisFastAdmissionOptions) {
    this.grace = options.abortGraceMs ?? 30_000;
    this.renewEvery = options.renewIntervalMs ?? 10_000;
    this.retention = options.replayRetentionMs ?? 86_400_000;
    if (
      !identity(options.namespace) ||
      !identity(options.runId) ||
      !integer(options.maxTtlMs, 1, 3_600_000) ||
      !integer(this.grace, 1, 600_000) ||
      !integer(this.renewEvery, 1, 60_000) ||
      !integer(this.retention, options.maxTtlMs + this.grace, 604_800_000)
    )
      throw new Error('Invalid fast admission options');
    // A valid ticket can wait until renewBy before starting its full upstream TTL.
    // Quarantine must cover that send delay as well as execution and abort grace.
    const maxSendValidityMs = Math.min(options.maxTtlMs, this.renewEvery * 3);
    this.horizon = Math.max(61_000, maxSendValidityMs + options.maxTtlMs + this.grace);
    this.prefix = `mr:fast:{${digest([options.namespace])}}`;
  }
  /** Bootstrap only, never called by acquire. drained requires externally verified upstream drain. */
  async initialize(options: { drained?: boolean } = {}): Promise<{ readyInMs: number }> {
    const result = decode(
      await this.options.redis.eval(INITIALIZE, {
        keys: [`${this.prefix}:generation`],
        arguments: [this.options.runId, String(this.horizon), options.drained === true ? 'drained' : 'quarantine'],
      }),
    );
    if (!result.ok || !integer(result.readyInMs ?? -1, 0, this.horizon))
      throw new Error('Fast admission initialization unavailable');
    return { readyInMs: result.readyInMs as number };
  }
  /** Health lane only. Never creates, resets or repairs authority state. */
  async checkReady(): Promise<boolean> {
    try {
      return decode(
        await this.options.redis.eval(CHECK_READY, {
          keys: [`${this.prefix}:generation`],
          arguments: [this.options.runId, String(this.horizon)],
        }),
      ).ok;
    } catch {
      return false;
    }
  }
  async acquire(input: FastAdmissionInput): Promise<FastAdmissionResult> {
    try {
      const ids = [
        input.requestId,
        input.tenantId,
        input.projectId,
        input.proxyKeyId,
        input.accountId,
        input.accountOwnerScope,
      ];
      if (
        !ids.every(identity) ||
        !integer(input.tokenUnits, 0, 1_000_000_000) ||
        !integer(input.ttlMs, 1, this.options.maxTtlMs) ||
        (input.accountOwnerScope !== 'platform' && input.accountOwnerScope !== input.tenantId)
      )
        throw new Error('Invalid fast admission input');
      if (
        (input.userId !== undefined && !identity(input.userId)) ||
        (input.groupId !== undefined && !identity(input.groupId)) ||
        (input.model !== undefined && !identity(input.model)) ||
        (input.acquisitionToken !== undefined && !identity(input.acquisitionToken))
      )
        throw new Error('Invalid fast admission identity');
      if ((input.limits.user && !input.userId) || (input.limits.group && !input.groupId))
        throw new Error('Fast admission limit scope missing');
      const scopes: [unknown[], FastLimit | undefined][] = [
        [['tenant', input.tenantId], input.limits.tenant],
        [['project', input.tenantId, input.projectId], input.limits.project],
        [['key', input.tenantId, input.projectId, input.proxyKeyId], input.limits.key],
        [['account', input.accountOwnerScope, input.accountId], input.limits.account],
      ];
      if (input.userId) scopes.push([['user', input.tenantId, input.userId], input.limits.user]);
      if (input.groupId) scopes.push([['group', input.groupId], input.limits.group]);
      const limits = scopes.map(([, limit]) => normalize(limit));
      const member = digest([input.tenantId, input.requestId]);
      const token = input.acquisitionToken ?? createHmac('sha256', this.secret).update(member).digest('hex');
      const account = digest([input.accountOwnerScope, input.accountId]);
      const keys = [
        `${this.prefix}:generation`,
        `${this.prefix}:lease:${member}`,
        `${this.prefix}:health:${account}`,
        `${this.prefix}:health:${account}:${digest([input.model ?? ''])}`,
        ...scopes.flatMap(([scope]) => [
          `${this.prefix}:slots:${digest(scope)}`,
          `${this.prefix}:rate:${digest(scope)}`,
        ]),
      ];
      const renewInterval = Math.min(this.renewEvery, Math.max(1, Math.floor(input.ttlMs / 4)));
      const renewWindow = Math.min(input.ttlMs, renewInterval * 3);
      const parameters = {
        runId: this.options.runId,
        horizon: this.horizon,
        member,
        token,
        incarnation: randomBytes(24).toString('hex'),
        admissionBucket: '',
        limits,
        tokenUnits: input.tokenUnits,
        ttl: input.ttlMs,
        grace: this.grace,
        renew: renewWindow,
        retention: this.retention,
        // Old Lua does not understand split usage/incarnation fencing. Version
        // the binding so old/new binaries cannot operate each other's records.
        binding: digest([
          'split-v1',
          ids,
          input.userId,
          input.groupId,
          input.model,
          input.tokenUnits,
          input.ttlMs,
          limits,
        ]),
      };
      const started = performance.now();
      const result = decode(await this.options.redis.eval(ACQUIRE, { keys, arguments: [JSON.stringify(parameters)] }));
      if (!result.ok)
        return {
          allowed: false,
          reason:
            result.reason === 'rate_limited' || result.reason === 'quota_exceeded' ? result.reason : 'unavailable',
          ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
        };
      if (
        result.token !== token ||
        !identity(result.incarnation) ||
        typeof result.bucket !== 'string' ||
        !/^[0-9]{1,12}$/.test(result.bucket) ||
        !integer(result.renewInMs ?? -1, 1, renewWindow)
      )
        throw new Error('Invalid fast admission receipt');
      // A retried acquire returns the existing incarnation, not our proposal.
      // Pin every operation to it to prevent ABA after a tombstone expires.
      parameters.incarnation = result.incarnation;
      parameters.admissionBucket = result.bucket;
      const reservedTokenUnits = input.tokenUnits;
      const hasModel = input.model !== undefined;
      const redis = this.options.redis;
      let validUntil = started + (result.renewInMs as number);
      let released = false;
      let invalid = performance.now() >= validUntil;
      let renewing: Promise<void> | undefined;
      let releasing: Promise<void> | undefined;
      let releasingConcurrency: Promise<void> | undefined;
      const validFeedback = (feedback: FastAdmissionFeedback | undefined): boolean =>
        !feedback ||
        (['success', 'failure', 'rate_limited'].includes(feedback.outcome) &&
          integer(feedback.cooldownMs ?? 0, 0, 3_600_000) &&
          (!feedback.modelOnly || hasModel) &&
          (feedback.actualTokenUnits === undefined ||
            (feedback.outcome === 'success' && integer(feedback.actualTokenUnits, 0, reservedTokenUnits))));
      // Captures only the Redis capability and immutable admission scalars/keys,
      // never request bodies, credentials, response handles or upstream objects.
      const complete = (operation: 'legacy' | 'concurrency', feedback?: FastAdmissionFeedback) =>
        redis
          .eval(RELEASE, {
            keys,
            arguments: [
              JSON.stringify({
                ...parameters,
                operation,
                ...(feedback ? { feedback: { ...feedback, cooldownMs: feedback.cooldownMs ?? 0 } } : {}),
              }),
            ],
          })
          .then((raw) => {
            if (!decode(raw).ok) throw new Error('Fast admission completion unavailable');
          });
      const lease: FastAdmissionLease = {
        fencingToken: `${parameters.runId}:${token}:${parameters.incarnation}`,
        renewIntervalMs: renewInterval,
        // Monotonic local fence avoids a redundant per-dispatch Redis command.
        async assertValid() {
          return !released && !invalid && performance.now() < validUntil;
        },
        renew: () => {
          if (renewing) return renewing;
          if (released || invalid) return Promise.reject(new Error('Fast admission lease lost'));
          const before = performance.now();
          renewing = redis
            .eval(RENEW, { keys, arguments: [JSON.stringify(parameters)] })
            .then((raw) => {
              const renewed = decode(raw);
              if (
                !renewed.ok ||
                renewed.token !== token ||
                renewed.incarnation !== parameters.incarnation ||
                !integer(renewed.renewInMs ?? -1, 1, renewWindow)
              )
                throw new Error('Fast admission lease lost');
              validUntil = before + (renewed.renewInMs as number);
              if (performance.now() >= validUntil) throw new Error('Fast admission lease lost');
            })
            .catch(() => {
              invalid = true;
              throw new Error('Fast admission lease lost');
            })
            .finally(() => {
              renewing = undefined;
            });
          return renewing;
        },
        release: (feedback) => {
          if (releasing) return releasing;
          // Release is still allowed after a failed renewal/expiry, but only by the bound owner.
          if (!validFeedback(feedback)) return Promise.reject(new Error('Invalid fast admission feedback'));
          released = true;
          releasing = complete('legacy', feedback).catch(() => {
            releasing = undefined;
            throw new Error('Fast admission release unavailable');
          });
          return releasing;
        },
        releaseConcurrency: (feedback) => {
          if (releasingConcurrency) return releasingConcurrency;
          if (!validFeedback(feedback) || feedback?.actualTokenUnits !== undefined)
            return Promise.reject(new Error('Invalid fast admission feedback'));
          released = true;
          releasingConcurrency = complete('concurrency', feedback).catch(() => {
            releasingConcurrency = undefined;
            throw new Error('Fast admission release unavailable');
          });
          return releasingConcurrency;
        },
        reconcileDurableUsage: durableUsageReconciler(redis, keys, JSON.stringify(parameters), reservedTokenUnits),
      };
      if (invalid) return { allowed: false, reason: 'unavailable' };
      return { allowed: true, lease };
    } catch {
      return { allowed: false, reason: 'unavailable' };
    }
  }
}
export function createRedisFastGatewayAdmission(options: RedisFastAdmissionOptions): RedisFastGatewayAdmission {
  return new RedisFastGatewayAdmission(options);
}

export interface OpenRedisFastAdmissionOptions extends Omit<RedisFastAdmissionOptions, 'redis' | 'runId'> {
  readonly url: string;
  /** Only initial isolated namespaces or an externally confirmed full transport drain. */
  readonly drained?: boolean;
}
export async function openRedisFastGatewayAdmission(options: OpenRedisFastAdmissionOptions): Promise<
  RedisFastGatewayAdmission & {
    close(): Promise<void>;
    readonly readyInMs: number;
    readonly cacheCommands: { sendCommand(args: string[]): Promise<unknown> };
  }
> {
  const client = createClient({
    url: options.url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 4096,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const command = () => client.withCommandOptions({ abortSignal: AbortSignal.timeout(2000) });
    const [info, configuration] = await Promise.all([
      command().info('server'),
      command().configGet('maxmemory-policy'),
    ]);
    const runId = /^run_id:([a-zA-Z0-9]+)\r?$/m.exec(info)?.[1];
    if (!runId || configuration['maxmemory-policy'] !== 'noeviction')
      throw new Error('Unsafe fast admission Redis configuration');
    const admission = new RedisFastGatewayAdmission({
      ...options,
      runId,
      redis: createRedisScriptTransport(command, [INITIALIZE, CHECK_READY, ACQUIRE, RENEW, RELEASE]),
    });
    const { readyInMs } = await admission.initialize({ drained: options.drained });
    return Object.assign(admission, {
      readyInMs,
      cacheCommands: { sendCommand: (args: string[]) => command().sendCommand(args) },
      async close() {
        if (client.isOpen) client.destroy();
      },
    });
  } catch {
    if (client.isOpen) client.destroy();
    throw new Error('Fast admission Redis unavailable');
  }
}
