import { randomUUID } from 'node:crypto';
import { PostgresQuotaStatePersistence } from '../../quota/postgres-state.js';
import type { QuotaStateBatch, QuotaStateRow, RedisQuotaState } from '../../quota/redis-state.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type {
  PostgresPreparationCapacityPort,
  PostgresPreparationCapacityReservation,
} from './postgres-preparation-ports.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationDecision,
  rejectRequestPreparation,
} from './request-preparation-service.js';

type Input = Parameters<PostgresPreparationCapacityPort['reserve']>[1];
type Limit = { rpm: bigint; tpm: bigint; concurrency: bigint };
type Limits = { tenant: Limit; project: Limit; key: Limit };
type Reservation = {
  kind: 'capacityRequest';
  requestId: string;
  tenantId: string;
  projectId: string;
  proxyKeyId: string;
  attemptId: string;
  supplyMode: 'byok' | 'platform';
  projectPolicyVersion: string;
  keyAuthzVersion: string;
  idempotencyScopeKey: string;
  requestFingerprint: string;
  requestFingerprintVersion: string;
  tokenUnits: number;
  quotaReservationId: string;
  rateReservationId: string;
  state: 'active' | 'completed' | 'cancelled';
  admittedAtMs: number;
  deadlineMs: number;
  scopes: string[];
  groupKey?: string;
  evictAfterPersist?: boolean;
};

const key = (...parts: string[]) => JSON.stringify(parts);
const requestKey = (id: string) => key('capacityRequest', id);
const scopeKeys = (input: Pick<Input, 'tenantId' | 'projectId' | 'proxyKeyId'>) => [
  key('capacityScope', 'tenant', input.tenantId),
  key('capacityScope', 'project', input.tenantId, input.projectId),
  key('capacityScope', 'key', input.tenantId, input.projectId, input.proxyKeyId),
];

const SCRIPT = `
local r=read(keys[1])
if input.op=='reserve' and r~=cjson.null then
  if r.tenantId~=input.tenantId or r.projectId~=input.projectId or r.proxyKeyId~=input.proxyKeyId
    or r.requestFingerprint~=input.requestFingerprint or r.idempotencyScopeKey~=input.idempotencyScopeKey
    or r.requestFingerprintVersion~=input.requestFingerprintVersion or r.tokenUnits~=input.tokenUnits then
    return {allowed=false,reason='idempotency_conflict'}
  end
  return r.state=='active' and {allowed=true,reservation=r} or {allowed=false,reason='idempotency_conflict'}
end
if input.op~='reserve' and (r==cjson.null or r.state~='active') then return {allowed=true} end
local scopes={}
local second=math.floor(now/1000)
for i=2,#keys do
  local scope=read(keys[i])
  if scope==cjson.null then scope={kind='capacityScope',active=0,windows={}} end
  local requests=0; local tokens=0
  for bucket,counts in pairs(scope.windows) do
    if tonumber(bucket)*1000+1000<=now-60000 then scope.windows[bucket]=nil
    else requests=requests+counts.requests; tokens=tokens+counts.tokens end
  end
  if input.op=='reserve' then
    local limit=input.limits[i-1]
    if limit.rpm and requests+1>limit.rpm then return {allowed=false,reason='rate_limited'} end
    if limit.tpm and tokens+input.tokenUnits>limit.tpm then return {allowed=false,reason='quota_exceeded'} end
    if limit.concurrency and scope.active+1>limit.concurrency then return {allowed=false,reason='rate_limited'} end
  end
  scopes[i]=scope
end
if input.op=='reserve' then
  r=input.record; r.admittedAtMs=now; r.deadlineMs=now+600000
  for i=2,#keys do
    local scope=scopes[i]
    local bucket=tostring(second)
    local counts=scope.windows[bucket] or {requests=0,tokens=0}
    counts.requests=counts.requests+1; counts.tokens=counts.tokens+input.tokenUnits
    scope.windows[bucket]=counts; scope.active=scope.active+1
    save(keys[i],scope)
  end
  save(keys[1],r)
  return {allowed=true,reservation=r}
else
  for i=2,#keys do
    local scope=scopes[i]
    scope.active=math.max(0,scope.active-1)
    if input.op=='cancel' then
      local bucket=tostring(math.floor(r.admittedAtMs/1000))
      local counts=scope.windows[bucket]
      if counts then counts.requests=math.max(0,counts.requests-1); counts.tokens=math.max(0,counts.tokens-r.tokenUnits) end
    end
    save(keys[i],scope)
  end
  r.state=input.op=='cancel' and 'cancelled' or 'completed'; r.evictAfterPersist=true
  save(keys[1],r)
  return {allowed=true}
end`;

/** SQL persistence and a one-time read-through bootstrap from existing PG reservations. */
export class PostgresCapacityStatePersistence extends PostgresQuotaStatePersistence {
  constructor(
    private readonly db: SaasDatabase,
    private readonly scope: string,
  ) {
    super(db, scope);
  }
  override async load(keys: string[]): Promise<QuotaStateRow[]> {
    const loaded = await super.load(keys);
    const found = new Set(loaded.map((row) => row.key));
    for (const field of keys) {
      if (found.has(field)) continue;
      const [kind, dimension, tenantId, projectId, proxyKeyId] = JSON.parse(field) as string[];
      if (kind === 'capacityRequest') {
        const result = await this.db.query<any>(
          `SELECT r.*,EXTRACT(EPOCH FROM r.reserved_at)*1000 AS admitted_ms,
          q.execution_state FROM saas_gateway_capacity_reservations r JOIN saas_requests q ON q.tenant_id=r.tenant_id AND q.id=r.request_id
          WHERE r.request_id=$1 LIMIT 2`,
          [dimension],
        );
        const row = result.rows.length === 1 ? result.rows[0] : undefined;
        if (row) {
          const value: Reservation = {
            kind: 'capacityRequest',
            requestId: row.request_id,
            tenantId: row.tenant_id,
            projectId: row.project_id,
            proxyKeyId: row.proxy_key_id,
            attemptId: row.attempt_id,
            supplyMode: row.supply_mode,
            projectPolicyVersion: String(row.project_policy_version),
            keyAuthzVersion: String(row.key_authz_version),
            idempotencyScopeKey: row.idempotency_scope_key,
            requestFingerprint: row.request_fingerprint,
            requestFingerprintVersion: row.request_fingerprint_version,
            tokenUnits: Number(row.token_units),
            quotaReservationId: row.quota_reservation_id,
            rateReservationId: row.rate_reservation_id,
            state:
              row.state === 'released'
                ? 'cancelled'
                : ['succeeded', 'failed'].includes(row.execution_state)
                  ? 'completed'
                  : 'active',
            admittedAtMs: Number(row.admitted_ms),
            deadlineMs: Number(row.admitted_ms) + 600000,
            scopes: scopeKeys({ tenantId: row.tenant_id, projectId: row.project_id, proxyKeyId: row.proxy_key_id }),
          };
          loaded.push({ key: field, value, version: 0 });
        }
      } else if (kind === 'capacityScope') {
        if (dimension === 'group') {
          const rows = await this.db.query<{ second: string; requests: string }>(
            `SELECT EXTRACT(EPOCH FROM window_start)::bigint::text AS second,requests::text
            FROM saas_billing_group_rate_counters WHERE group_id=$1 AND window_start>clock_timestamp()-INTERVAL '61 seconds'`,
            [tenantId],
          );
          loaded.push({
            key: field,
            version: 0,
            value: {
              kind,
              active: 0,
              windows: Object.fromEntries(
                rows.rows.map((row) => [row.second, { requests: Number(row.requests), tokens: 0 }]),
              ),
            },
          });
          continue;
        }
        const values = [tenantId, projectId ?? null, proxyKeyId ?? null];
        const where = `tenant_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::uuid IS NULL OR proxy_key_id=$3)`;
        const rates = await this.db.query<{ second: string; requests: string; tokens: string }>(
          `SELECT FLOOR(EXTRACT(EPOCH FROM reserved_at))::bigint::text AS second,
          COUNT(*)::text AS requests,SUM(token_units)::text AS tokens FROM saas_gateway_capacity_reservations
          WHERE ${where} AND state IN ('reserved','retained_for_reconciliation') AND reserved_at>clock_timestamp()-INTERVAL '61 seconds' GROUP BY second`,
          values,
        );
        const active = await this.db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM saas_requests WHERE ${where}
          AND execution_state IN ('pending','unknown') AND updated_at>clock_timestamp()-INTERVAL '600 seconds'`,
          values,
        );
        loaded.push({
          key: field,
          version: 0,
          value: {
            kind,
            active: Number(active.rows[0]?.n ?? 0),
            windows: Object.fromEntries(
              rates.rows.map((row) => [row.second, { requests: Number(row.requests), tokens: Number(row.tokens) }]),
            ),
          },
        });
      }
    }
    return loaded;
  }
  override async apply(batches: QuotaStateBatch[]): Promise<void> {
    await super.apply(batches);
    await this.project();
  }
  override async ping(generation?: number): Promise<void> {
    await super.ping(generation);
    await this.project();
  }
  private async project(): Promise<void> {
    // The Redis reservation can precede the admission transaction's commit.
    // Joining committed request/attempt rows makes that normal race a deferred
    // projection, not a DB outage or a lost event.
    await this.db.query(
      `WITH ready AS (
      SELECT s.namespace,s.key,s.value,s.generation,s.version FROM saas_redis_quota_state s
      JOIN saas_requests q ON q.tenant_id=(s.value->>'tenantId')::uuid AND q.id=(s.value->>'requestId')::uuid
      JOIN saas_attempts a ON a.tenant_id=q.tenant_id AND a.request_id=q.id AND a.id=(s.value->>'attemptId')::uuid
      WHERE s.namespace=$1 AND s.projection_pending AND s.value->>'kind'='capacityRequest' LIMIT 100
    ), inserted AS (
      INSERT INTO saas_gateway_capacity_reservations(tenant_id,project_id,proxy_key_id,request_id,attempt_id,supply_mode,
        project_policy_version,key_authz_version,idempotency_scope_key,request_fingerprint,request_fingerprint_version,token_units,
        quota_reservation_id,rate_reservation_id,state,reserved_at)
      SELECT (value->>'tenantId')::uuid,(value->>'projectId')::uuid,(value->>'proxyKeyId')::uuid,(value->>'requestId')::uuid,
        (value->>'attemptId')::uuid,value->>'supplyMode',(value->>'projectPolicyVersion')::bigint,(value->>'keyAuthzVersion')::bigint,
        value->>'idempotencyScopeKey',value->>'requestFingerprint',value->>'requestFingerprintVersion',(value->>'tokenUnits')::bigint,
        (value->>'quotaReservationId')::uuid,(value->>'rateReservationId')::uuid,
        CASE WHEN value->>'state'='cancelled' THEN 'released' ELSE 'reserved' END,to_timestamp((value->>'admittedAtMs')::double precision/1000)
      FROM ready ON CONFLICT(tenant_id,request_id) DO UPDATE SET state=CASE WHEN excluded.state='released' AND saas_gateway_capacity_reservations.state='reserved' THEN 'released' ELSE saas_gateway_capacity_reservations.state END,
        updated_at=clock_timestamp() RETURNING request_id
    ) UPDATE saas_redis_quota_state s SET projection_pending=false FROM ready
      WHERE s.namespace=ready.namespace AND s.key=ready.key AND s.generation=ready.generation AND s.version=ready.version`,
      [this.scope],
    );
  }
}

export class RedisPreparationCapacity {
  private timer?: NodeJS.Timeout;
  private recoveryRun?: Promise<void>;
  private closing?: Promise<void>;
  private readonly localAdmissions = new Set<string>();
  constructor(
    readonly state: RedisQuotaState,
    private readonly database: SaasDatabase,
    private readonly namespace: string,
  ) {}
  async reserve(
    executor: SqlExecutor,
    input: Input,
    limits: Limits,
    policyVersion: bigint,
    keyVersion: bigint,
    group: { billingGroupId: string; rpmLimit: bigint | null } | null,
    tokenUnits: bigint,
  ): Promise<RequestPreparationDecision<PostgresPreparationCapacityReservation>> {
    const toNumber = (n: bigint): number => {
      if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quota limit exceeds exact range');
      return Number(n);
    };
    const scopes = scopeKeys(input);
    const policies: { rpm?: number; tpm?: number; concurrency?: number }[] = Object.values(limits).map((limit) => ({
      rpm: toNumber(limit.rpm),
      tpm: toNumber(limit.tpm),
      concurrency: toNumber(limit.concurrency),
    }));
    if (group?.rpmLimit !== null && group?.rpmLimit !== undefined) {
      scopes.push(key('capacityScope', 'group', group.billingGroupId));
      policies.push({ rpm: toNumber(group.rpmLimit) });
    }
    const record: Omit<Reservation, 'admittedAtMs' | 'deadlineMs'> = {
      kind: 'capacityRequest',
      requestId: input.requestId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      proxyKeyId: input.proxyKeyId,
      attemptId: input.attemptId,
      supplyMode: input.supplyMode,
      projectPolicyVersion: policyVersion.toString(),
      keyAuthzVersion: keyVersion.toString(),
      idempotencyScopeKey: input.idempotencyScopeKey,
      requestFingerprint: input.requestFingerprint,
      requestFingerprintVersion: input.requestFingerprintVersion,
      tokenUnits: toNumber(tokenUnits),
      quotaReservationId: randomUUID(),
      rateReservationId: randomUUID(),
      state: 'active',
      scopes,
    };
    const reply = await this.state.mutate<{ allowed: boolean; reason?: string; reservation?: Reservation }>(
      [requestKey(input.requestId), ...scopes],
      SCRIPT,
      {
        ...input,
        payloadBounds: undefined,
        op: 'reserve',
        admission: true,
        tokenUnits: toNumber(tokenUnits),
        limits: policies,
        record,
        ...(input.newRequest ? { freshKey: requestKey(input.requestId) } : {}),
      },
    );
    if (!reply.allowed || !reply.reservation) {
      if (reply.reason === 'quota_unavailable')
        return blockRequestPreparation('storage_failure', 'Shared quota persistence is unavailable.');
      return rejectRequestPreparation(
        reply.reason === 'quota_exceeded'
          ? 'quota_exceeded'
          : reply.reason === 'idempotency_conflict'
            ? 'idempotency_conflict'
            : 'rate_limited',
        'The request exceeds shared capacity limits.',
      );
    }
    const r = reply.reservation;
    // Execution evidence stays on the admission transaction. No quota counters
    // or shared quota rows are written synchronously here.
    await this.receipt(executor, input.tenantId, input.requestId, r.quotaReservationId, r.rateReservationId);
    return allowRequestPreparation({
      quotaReservation: { reference: r.quotaReservationId, state: 'reserved' },
      rateReservation: { reference: r.rateReservationId, state: 'reserved' },
      retryBudget: 0,
      remainingAttempts: 1,
      usageBudget: { unit: 'tokens', amount: r.tokenUnits, basis: 'reserved' },
    });
  }
  async receipt(
    executor: SqlExecutor,
    tenantId: string,
    requestId: string,
    quotaId: string,
    rateId: string,
  ): Promise<void> {
    this.localAdmissions.add(requestId);
    const result = await executor.query(
      `UPDATE saas_requests SET capacity_backend='redis',redis_quota_reservation_id=$3,redis_rate_reservation_id=$4,
        state_version=state_version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2 AND execution_state='pending' RETURNING id`,
      [tenantId, requestId, quotaId, rateId],
    );
    if (result.rows.length !== 1) throw new Error('Quota dispatch receipt unavailable');
  }
  async find(id: string): Promise<Record<string, unknown> | null> {
    const r = await this.state.read<Reservation>(requestKey(id));
    return r
      ? {
          tenant_id: r.tenantId,
          project_id: r.projectId,
          proxy_key_id: r.proxyKeyId,
          request_id: r.requestId,
          attempt_id: r.attemptId,
          supply_mode: r.supplyMode,
          project_policy_version: r.projectPolicyVersion,
          key_authz_version: r.keyAuthzVersion,
          idempotency_scope_key: r.idempotencyScopeKey,
          request_fingerprint: r.requestFingerprint,
          request_fingerprint_version: r.requestFingerprintVersion,
          token_units: r.tokenUnits,
          quota_reservation_id: r.quotaReservationId,
          rate_reservation_id: r.rateReservationId,
          state: r.state === 'active' ? 'reserved' : 'released',
        }
      : null;
  }
  async cancel(id: string): Promise<void> {
    const r = await this.state.read<Reservation>(requestKey(id));
    if (r?.state === 'active') await this.state.mutate([requestKey(id), ...r.scopes], SCRIPT, { op: 'cancel' });
  }
  async complete(id: string, recovery = false): Promise<void> {
    if (!recovery && !this.localAdmissions.has(id)) return;
    const r = await this.state.read<Reservation>(requestKey(id));
    if (!r || r.state !== 'active') {
      this.localAdmissions.delete(id);
      return;
    }
    const result = await this.database.query<{ execution_state: string; any_sent: boolean }>(
      `SELECT q.execution_state,EXISTS(SELECT 1 FROM saas_attempts a WHERE a.tenant_id=q.tenant_id AND a.request_id=q.id AND a.dispatch_state<>'not_sent') AS any_sent
      FROM saas_requests q WHERE q.tenant_id=$1 AND q.id=$2`,
      [r.tenantId, r.requestId],
    );
    const row = result.rows[0];
    // A deadline is a recovery scan hint, not evidence that an execution ended.
    // Pending/unknown work keeps capacity until SQL records a terminal outcome.
    if (row && !['succeeded', 'failed'].includes(row.execution_state)) return;
    if (!row && r.deadlineMs > Date.now()) return;
    const op = !row || !row.any_sent ? 'cancel' : 'complete';
    await this.state.mutate([requestKey(id), ...r.scopes], SCRIPT, { op });
    this.localAdmissions.delete(id);
  }
  startRecovery(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.recover().catch(() => {}), 1000);
    this.timer.unref();
  }
  private recover(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.recoveryRun) return this.recoveryRun;
    const operation = (async () => {
      const rows = await this.database.query<{ id: string }>(
        `SELECT s.value->>'requestId' AS id FROM saas_redis_quota_state s
        LEFT JOIN saas_requests q ON q.tenant_id=(s.value->>'tenantId')::uuid AND q.id=(s.value->>'requestId')::uuid
        WHERE s.namespace=$1 AND s.value->>'kind'='capacityRequest' AND s.value->>'state'='active'
          AND (q.execution_state IN ('succeeded','failed') OR (q.id IS NULL AND (s.value->>'deadlineMs')::bigint<=$2)) LIMIT 100`,
        [this.namespace, Date.now()],
      );
      for (const row of rows.rows) await this.complete(row.id, true);
    })();
    this.recoveryRun = operation;
    void operation.finally(() => { this.recoveryRun = undefined; }).catch(() => {});
    return operation;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.timer = undefined;
    this.closing = (async () => {
      // A recovery scan can still mutate quota state after its SQL read.
      // Drain it before Redis flush/close and before its owned DB lane closes.
      await this.recoveryRun?.catch(() => {});
      await this.state.close();
    })();
    return this.closing;
  }
}
