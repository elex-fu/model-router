import type { QuotaAdmission, QuotaBalance, QuotaDecision } from './ledger.js';
import { RedisQuotaState, type QuotaStatePersistence } from './redis-state.js';

export const quotaStateKey = (...parts: string[]): string => JSON.stringify(parts);

interface RequestState {
  kind: 'request';
  requestId: string;
  proxyKeyId: string;
  periodId: string;
  state: string;
  sent: number;
  usage: Record<string, number>;
  reservedTokens: number;
  deadlineMs: number;
  periodEndMs: number;
}
interface PeriodState {
  reportedUsed: number;
  estimatedUsed: number;
  reserved: number;
  adjustmentTokens: number;
}

const LEDGER_SCRIPT = `
local op=input.op
local a=read(keys[1])
local p=read(keys[2])
local r=keys[3] and read(keys[3]) or cjson.null
if a==cjson.null then a={kind='account',proxyKeyId=input.proxyKeyId,activeRequests=0,rpm={}} end
if p==cjson.null then p={kind='period',proxyKeyId=input.proxyKeyId,periodId=input.periodId,
  startMs=input.periodStartMs or 0,endMs=input.periodEndMs or 0,timezoneVersionId=input.timezoneVersionId,
  reportedUsed=0,estimatedUsed=0,reserved=0,adjustmentTokens=0} end
local function denied(reason,retry) return {allowed=false,reason=reason,retryAfterMs=retry} end
local function enough(extra)
  return not input.dailyTokens or (input.dailyTokens>0 and p.reportedUsed+p.estimatedUsed+p.reserved+p.adjustmentTokens+extra<=input.dailyTokens)
end
if op=='admit' then
  if r~=cjson.null then
    if r.proxyKeyId~=input.proxyKeyId or r.periodId~=input.periodId then error('QUOTA_IDEMPOTENCY_CONFLICT') end
    return r.state=='active' and {allowed=true} or denied('daily_tokens_exceeded')
  end
  if input.maxConcurrentRequests and a.activeRequests>=input.maxConcurrentRequests then return denied('concurrency_exceeded') end
  local count=0
  local oldest=nil
  for second,n in pairs(a.rpm) do
    if tonumber(second)*1000+1000<=now-60000 then a.rpm[second]=nil
    else count=count+n; if not oldest or tonumber(second)<oldest then oldest=tonumber(second) end end
  end
  if input.rpm and count>=input.rpm then return denied('rpm_exceeded',oldest and math.max(1,oldest*1000+61000-now) or 60000) end
  if not enough(input.reserveTokens) then return denied('daily_tokens_exceeded',input.periodEndMs-now) end
  if p.startMs==0 then p.startMs=input.periodStartMs; p.endMs=input.periodEndMs; p.timezoneVersionId=input.timezoneVersionId end
  a.activeRequests=a.activeRequests+1
  local second=tostring(math.floor(now/1000))
  a.rpm[second]=(a.rpm[second] or 0)+1
  p.reserved=p.reserved+input.reserveTokens
  r={kind='request',requestId=input.requestId,proxyKeyId=input.proxyKeyId,periodId=input.periodId,
     reservedTokens=input.reserveTokens,attemptReserveTokens=input.reserveTokens,settledTokens=0,
     state='active',sent=0,usage={},sentAttempts={},missingUsagePolicy=input.missingUsagePolicy or 'estimate',
     admittedAtMs=now,deadlineMs=now+600000,periodEndMs=input.periodEndMs}
  save(keys[1],a); save(keys[2],p); save(keys[3],r)
  return {allowed=true}
elseif op=='adjust' then
  if r~=cjson.null then
    if r.proxyKeyId~=input.proxyKeyId or r.periodId~=input.periodId or r.deltaTokens~=input.deltaTokens or r.reason~=input.reason then error('QUOTA_ADJUSTMENT_CONFLICT') end
    return true
  end
  p.adjustmentTokens=p.adjustmentTokens+input.deltaTokens
  save(keys[2],p)
  save(keys[3],{kind='adjustment',id=input.id,proxyKeyId=input.proxyKeyId,periodId=input.periodId,
    deltaTokens=input.deltaTokens,reason=input.reason,createdAtMs=now,evictAfterPersist=true})
  return true
elseif op=='balance' then
  return {reportedUsed=p.reportedUsed,estimatedUsed=p.estimatedUsed,reserved=p.reserved,
    adjustmentTokens=p.adjustmentTokens,activeRequests=a.activeRequests}
end
if r==cjson.null then error('QUOTA_REQUEST_MISSING') end
if r.proxyKeyId~=input.proxyKeyId or r.periodId~=input.periodId then error('QUOTA_SCOPE_CONFLICT') end
if op=='expireRetained' then
  if r.state~='retained' or p.endMs>now then return true end
  p.reserved=p.reserved-r.reservedTokens; p.estimatedUsed=p.estimatedUsed+r.reservedTokens
  r.settledTokens=r.settledTokens+r.reservedTokens; r.reservedTokens=0; r.state='estimated'; r.evictAfterPersist=true
  save(keys[2],p); save(keys[3],r); return true
end
if r.state~='active' then return op=='topUp' and denied('daily_tokens_exceeded') or true end
if op=='topUp' then
  local overflow=math.max(0,input.reportedTokensSoFar-r.reservedTokens)
  if not enough(input.extraTokens+overflow) then return denied('daily_tokens_exceeded',p.endMs-now) end
  r.reservedTokens=r.reservedTokens+input.extraTokens; p.reserved=p.reserved+input.extraTokens
  save(keys[2],p); save(keys[3],r); return {allowed=true}
elseif op=='sent' then
  r.sentAttempts=r.sentAttempts or {}
  if not input.attemptId or not r.sentAttempts[input.attemptId] then
    r.sent=r.sent+1
    if input.attemptId then r.sentAttempts[input.attemptId]=true end
    save(keys[3],r)
  end
  return true
elseif op=='usage' then
  local previous=r.usage[input.attemptId]
  if previous and previous~=input.reportedTokens then error('QUOTA_USAGE_CONFLICT') end
  if not previous then r.usage[input.attemptId]=input.reportedTokens; save(keys[3],r) end
  return true
elseif op=='settle' then
  local known=input.reportedTokens~=cjson.null and input.reportedTokens or 0
  local unknown=input.unknownSentAttempts
  if not unknown then unknown=input.reportedTokens==cjson.null and r.sent or 0 end
  if input.recover then
    if r.deadlineMs>now then return true end
    known=0; local reports=0
    for _,tokens in pairs(r.usage) do known=known+tokens; reports=reports+1 end
    unknown=math.max(0,r.sent-reports)
  end
  local bound=r.missingUsagePolicy=='estimate' and r.reservedTokens or math.min(r.reservedTokens,unknown*r.attemptReserveTokens)
  local retained=unknown>0 and r.missingUsagePolicy=='retain-reservation' and bound or 0
  local estimated=unknown>0 and r.missingUsagePolicy=='estimate' and bound or 0
  if p.endMs<=now then estimated=estimated+retained; retained=0 end
  p.reserved=p.reserved-r.reservedTokens+retained
  p.reportedUsed=p.reportedUsed+known; p.estimatedUsed=p.estimatedUsed+estimated
  a.activeRequests=math.max(0,a.activeRequests-1)
  r.reservedTokens=retained; r.settledTokens=known+estimated
  r.state=retained>0 and 'retained' or estimated>0 and 'estimated' or unknown>0 and 'released_unknown' or 'settled'
  r.evictAfterPersist=retained==0
  save(keys[1],a); save(keys[2],p); save(keys[3],r); return true
end
error('QUOTA_OPERATION_UNKNOWN')`;

function nonnegative(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError('Invalid quota value');
}

/** No quota balances live in process memory; only immutable request routing does. */
export class RedisQuotaLedger {
  private readonly routes = new Map<string, { proxyKeyId: string; periodId: string }>();
  private recovery?: NodeJS.Timeout;
  private recovering = false;
  constructor(
    readonly state: RedisQuotaState,
    private readonly persistence?: QuotaStatePersistence,
  ) {}

  startRecovery(): void {
    if (!this.persistence?.expiredRequests || this.recovery) return;
    this.recovery = setInterval(() => void this.recoverInterrupted().catch(() => {}), 1000);
    this.recovery.unref();
  }
  private keys(proxyKeyId: string, periodId: string, requestId?: string): string[] {
    return [
      quotaStateKey('account', proxyKeyId),
      quotaStateKey('period', proxyKeyId, periodId),
      ...(requestId ? [quotaStateKey('request', requestId)] : []),
    ];
  }
  async admit(a: QuotaAdmission): Promise<QuotaDecision> {
    for (const n of [a.reserveTokens, a.dailyTokens, a.rpm, a.maxConcurrentRequests]) nonnegative(n);
    if (a.periodEndMs <= a.atMs || a.periodStartMs > a.atMs) throw new RangeError('Invalid quota period');
    const decision = await this.state.mutate<QuotaDecision>(
      this.keys(a.proxyKeyId, a.periodId, a.requestId),
      LEDGER_SCRIPT,
      {
        ...a,
        op: 'admit',
        admission: true,
        ...(a.newRequest ? { freshKey: quotaStateKey('request', a.requestId) } : {}),
      },
    );
    if (decision.allowed) this.routes.set(a.requestId, { proxyKeyId: a.proxyKeyId, periodId: a.periodId });
    return decision;
  }
  private async operate<T>(requestId: string, input: Record<string, unknown>): Promise<T> {
    const route =
      this.routes.get(requestId) ?? (await this.state.read<RequestState>(quotaStateKey('request', requestId)));
    if (!route) throw new Error('Quota reservation not found');
    return this.state.mutate<T>(this.keys(route.proxyKeyId, route.periodId, requestId), LEDGER_SCRIPT, {
      ...input,
      requestId,
      proxyKeyId: route.proxyKeyId,
      periodId: route.periodId,
    });
  }
  topUp(requestId: string, extraTokens: number, dailyTokens?: number, reportedTokensSoFar = 0): Promise<QuotaDecision> {
    for (const n of [extraTokens, dailyTokens, reportedTokensSoFar]) nonnegative(n);
    return this.operate(requestId, { op: 'topUp', extraTokens, dailyTokens, reportedTokensSoFar, admission: true });
  }
  async markAttemptSent(requestId: string, attemptId?: string): Promise<void> {
    await this.operate(requestId, { op: 'sent', attemptId });
  }
  async recordAttemptUsage(requestId: string, attemptId: string, reportedTokens: number): Promise<void> {
    nonnegative(reportedTokens);
    await this.operate(requestId, { op: 'usage', attemptId, reportedTokens });
  }
  async settle(requestId: string, reportedTokens: number | null, unknownSentAttempts?: number): Promise<void> {
    if (reportedTokens !== null) nonnegative(reportedTokens);
    nonnegative(unknownSentAttempts);
    if (!this.routes.has(requestId) && !(await this.state.read<RequestState>(quotaStateKey('request', requestId))))
      return;
    await this.operate(requestId, { op: 'settle', reportedTokens, unknownSentAttempts });
    this.routes.delete(requestId);
  }
  async balance(proxyKeyId: string, periodId: string): Promise<QuotaBalance> {
    return this.state.mutate(this.keys(proxyKeyId, periodId), LEDGER_SCRIPT, { op: 'balance', proxyKeyId, periodId });
  }
  async adjust(id: string, proxyKeyId: string, periodId: string, deltaTokens: number, reason: string): Promise<void> {
    if (!Number.isSafeInteger(deltaTokens) || !reason.trim()) throw new RangeError('Invalid adjustment');
    await this.state.mutate([...this.keys(proxyKeyId, periodId), quotaStateKey('adjustment', id)], LEDGER_SCRIPT, {
      op: 'adjust',
      id,
      proxyKeyId,
      periodId,
      deltaTokens,
      reason,
    });
  }
  async recoverInterrupted(): Promise<number> {
    if (this.recovering || !this.persistence?.expiredRequests) return 0;
    this.recovering = true;
    try {
      const requests = await this.persistence.expiredRequests(Date.now(), 100);
      for (const id of requests) {
        const r = await this.state.read<RequestState>(quotaStateKey('request', id));
        if (!r) continue;
        await this.operate(id, {
          op: r.state === 'retained' ? 'expireRetained' : 'settle',
          reportedTokens: null,
          recover: true,
        });
        this.routes.delete(id);
      }
      return requests.length;
    } finally {
      this.recovering = false;
    }
  }
  async ping(): Promise<void> {
    if (!(await this.state.status()).healthy) throw new Error('Quota persistence unavailable');
  }
  async close(): Promise<void> {
    clearInterval(this.recovery);
    await this.state.close();
  }
}
