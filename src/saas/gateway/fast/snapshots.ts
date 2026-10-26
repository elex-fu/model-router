import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deserialize, serialize } from 'node:v8';
import { canonicalizeIpPolicy, type IpPolicy, isIpAllowed } from '../../keys/ip-policy.js';
import type { AuthenticatedApiKey } from '../../keys/types.js';
import type { CustomerPriceVersionRecord, SupplierCostVersionRecord } from '../../pricing/types.js';
import type { GatewayProviderCredentialUnsealInput } from '../../runtime/gateway-provider-credential-unsealer.js';
import type { ClientAddressResolution } from '../client-address.js';
import type {
  RequestPreparationAuthority,
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
} from '../request-preparation-service.js';

export interface FastGatewayRateLimits {
  readonly rpm: number;
  readonly tpm: number;
  readonly concurrency: number;
}
export interface FastGatewayCandidate {
  readonly authority: RequestPreparationCandidateAuthority;
  /** Sealed envelope only; plaintext credentials must never enter a snapshot. */
  readonly credential: GatewayProviderCredentialUnsealInput;
  readonly customerPrice: CustomerPriceVersionRecord | null;
  readonly supplierCost: SupplierCostVersionRecord | null;
  readonly limits: { readonly rpm: number | null; readonly tpm: number | null; readonly concurrency: number };
}
export interface FastGatewaySnapshot {
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly authority: RequestPreparationAuthority;
  readonly candidates: readonly FastGatewayCandidate[];
  /** Original cold validation time; never rewritten by either cache tier. */
  readonly observedAtMs: number;
  /** Hard non-sliding deadline, additionally capped by every source absolute expiry. */
  readonly validUntilMs: number;
  readonly revision: string;
  readonly policy: {
    readonly keyStatus: 'active' | 'inactive';
    readonly tenantStatus: 'active' | 'inactive';
    readonly projectStatus: 'active' | 'inactive';
    readonly principalStatus: 'active' | 'inactive';
    readonly groupStatus: 'active' | 'inactive' | null;
    /** Tenant-wide financial freeze; BYOK carries but does not consume platform spend. */
    readonly spendingFrozen: boolean;
    readonly ipPolicy: Readonly<IpPolicy>;
    readonly maxBodyBytes: number;
    readonly absoluteExpiryMs: readonly number[];
  };
  readonly limits: {
    readonly tenant: FastGatewayRateLimits;
    readonly project: FastGatewayRateLimits;
    readonly key: FastGatewayRateLimits;
    readonly group: { readonly id: string; readonly rpm: number | null } | null;
  };
}
export interface FastGatewaySnapshotInput {
  readonly authenticatedCaller: AuthenticatedApiKey;
  readonly publicModel: string;
  readonly protocol: 'openai';
  readonly clientOperation: string;
  /** Must come from the trusted HTTP peer/proxy resolver, not from a body field. */
  readonly clientAddress?: ClientAddressResolution | null;
  readonly inputByteLength?: number;
}
export interface FastGatewaySnapshotProvider {
  /** null means unsupported, before any admission/dispatch intent. Denials/errors throw safely. */
  resolve(input: FastGatewaySnapshotInput): Promise<FastGatewaySnapshot | null>;
}
export type FastGatewaySnapshotErrorCode = 'SNAPSHOT_DENIED' | 'SNAPSHOT_UNAVAILABLE' | 'SNAPSHOT_BUSY';
export class FastGatewaySnapshotError extends Error {
  constructor(readonly code: FastGatewaySnapshotErrorCode) {
    super(code === 'SNAPSHOT_DENIED' ? 'Fast gateway request is not authorized' : 'Fast gateway authority unavailable');
    this.name = 'FastGatewaySnapshotError';
  }
}
export interface FastGatewaySnapshotCacheStore {
  /** A failed read MUST throw; null is only a successful cache miss. */
  get(key: string): Promise<Buffer | null>;
  /** Must confirm the write; no silently fail-open adapter is suitable here. */
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
}
export type FastGatewaySnapshotMetric =
  | 'l1_hit'
  | 'l2_hit'
  | 'cold_load'
  | 'coalesced'
  | 'negative_hit'
  | 'denied'
  | 'unavailable'
  | 'invalidated';
export interface FastGatewaySnapshotCacheOptions {
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly maxEntries?: number;
  readonly maxPending?: number;
  readonly loadTimeoutMs?: number;
  readonly maxCacheBytes?: number;
  readonly wallNow?: () => number;
  readonly monotonicNow?: () => number;
  readonly store?: FastGatewaySnapshotCacheStore;
  /** Required with L2. Deployment-owned AES-256 key; never an API/provider secret. */
  readonly encryptionKey?: Uint8Array;
  readonly namespace?: string;
  readonly observe?: (metric: FastGatewaySnapshotMetric) => void;
}

type Entry = {
  readonly value: FastGatewaySnapshot | null;
  readonly until: number;
  readonly wallUntil: number;
  readonly epoch: bigint;
};
const MAX_TTL_MS = 5_000;
// The immutable object, not a caller-supplied timestamp, carries its local lease.
// Post-intent authorization can therefore recheck epoch/outage/monotonic expiry
// without any database or Redis read. Weak keys do not retain evicted snapshots.
const localSnapshotLeases = new WeakMap<FastGatewaySnapshot, () => number>();
function fail(code: FastGatewaySnapshotErrorCode): never {
  throw new FastGatewaySnapshotError(code);
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes('\0')
  );
}
function version(value: unknown): string {
  try {
    const n = BigInt(String(value));
    if (n > 0n) return n.toString();
  } catch {
    /* invalid */
  }
  return fail('SNAPSHOT_DENIED');
}
/** Complete safe caller scope; secrets are neither accepted nor used in keys. */
export function fastGatewaySnapshotCacheKey(
  input: FastGatewaySnapshotInput,
  namespace = 'model-router:fast:v1',
): string {
  const a = input?.authenticatedCaller?.authorization;
  if (!a || input.protocol !== 'openai' || !text(input.publicModel) || !text(input.clientOperation))
    fail('SNAPSHOT_DENIED');
  const ids = [
    a.tenantId,
    a.projectId,
    a.keyId,
    a.principalKind,
    a.principalId,
    a.entitlementId,
    a.supplyProfileId,
    a.supplyMode,
  ];
  if (!ids.every(text) || !Array.isArray(a.modelScopes) || !a.modelScopes.every(text)) fail('SNAPSHOT_DENIED');
  return `${namespace}:${createHash('sha256')
    .update(
      JSON.stringify([
        ...ids,
        [...a.modelScopes].sort(),
        version(a.authzVersion),
        version(a.modelScopeVersion),
        version(a.entitlementAuthzVersion),
        version(a.supplyProfileAuthzVersion),
        input.publicModel,
        input.protocol,
        input.clientOperation,
      ]),
    )
    .digest('hex')}`;
}
function sameVersion(a: unknown, b: unknown): boolean {
  return version(a) === version(b);
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
}
function assertLimit(limit: FastGatewayRateLimits): void {
  if (!limit || ![limit.rpm, limit.tpm, limit.concurrency].every(positive)) fail('SNAPSHOT_UNAVAILABLE');
}
/** Pure per-request authorization. No storage, no freshness query, no authority renewal. */
export function authorizeFastGatewaySnapshot(
  snapshot: FastGatewaySnapshot,
  input: FastGatewaySnapshotInput,
  now = Date.now(),
): void {
  try {
    const lease = localSnapshotLeases.get(snapshot);
    if (lease) now = Math.max(now, lease());
    const a = input.authenticatedCaller.authorization;
    const m = input.authenticatedCaller.metadata;
    const c = snapshot.caller;
    const e = snapshot.entitlement;
    const r = snapshot.authority.route;
    const p = snapshot.policy;
    if (typeof p.spendingFrozen !== 'boolean') fail('SNAPSHOT_UNAVAILABLE');
    if (c.supplyMode === 'platform' && p.spendingFrozen) fail('SNAPSHOT_DENIED');
    if (
      !Number.isFinite(now) ||
      !positive(snapshot.observedAtMs) ||
      !positive(snapshot.validUntilMs) ||
      snapshot.observedAtMs > now ||
      snapshot.validUntilMs <= now ||
      !text(snapshot.revision)
    )
      fail('SNAPSHOT_UNAVAILABLE');
    if (
      p.keyStatus !== 'active' ||
      p.tenantStatus !== 'active' ||
      p.projectStatus !== 'active' ||
      p.principalStatus !== 'active' ||
      (p.groupStatus !== null && p.groupStatus !== 'active')
    )
      fail('SNAPSHOT_DENIED');
    if (
      m.status !== 'active' ||
      m.id !== a.keyId ||
      m.tenantId !== a.tenantId ||
      m.projectId !== a.projectId ||
      m.revokedAt !== null ||
      (m.expiresAt !== null && !(Date.parse(m.expiresAt) > now))
    )
      fail('SNAPSHOT_DENIED');
    if (
      m.executionPrincipalType !== a.principalKind ||
      m.executionPrincipalId !== a.principalId ||
      m.entitlementId !== a.entitlementId ||
      m.supplyProfileId !== a.supplyProfileId ||
      m.supplyMode !== a.supplyMode ||
      !sameSet(m.modelScopes, a.modelScopes) ||
      !sameVersion(m.authzVersion, a.authzVersion) ||
      !sameVersion(m.modelScopeVersion, a.modelScopeVersion) ||
      !sameVersion(m.entitlementAuthzVersion, a.entitlementAuthzVersion) ||
      !sameVersion(m.supplyProfileAuthzVersion, a.supplyProfileAuthzVersion)
    )
      fail('SNAPSHOT_DENIED');
    if (
      c.tenantId !== a.tenantId ||
      c.projectId !== a.projectId ||
      c.proxyKeyId !== a.keyId ||
      c.principalKind !== a.principalKind ||
      c.principalId !== a.principalId ||
      c.entitlementId !== a.entitlementId ||
      c.supplyProfileId !== a.supplyProfileId ||
      c.supplyMode !== a.supplyMode ||
      !sameSet(c.modelScopes, a.modelScopes) ||
      !sameVersion(c.authzVersion, a.authzVersion) ||
      !sameVersion(c.modelScopeVersion, a.modelScopeVersion) ||
      !sameVersion(c.entitlementVersion, a.entitlementAuthzVersion) ||
      !sameVersion(c.supplyProfileVersion, a.supplyProfileAuthzVersion)
    )
      fail('SNAPSHOT_DENIED');
    if (
      e.tenantId !== c.tenantId ||
      e.projectId !== c.projectId ||
      e.proxyKeyId !== c.proxyKeyId ||
      e.entitlementId !== c.entitlementId ||
      e.supplyProfileId !== c.supplyProfileId ||
      e.supplyMode !== c.supplyMode ||
      !sameVersion(e.entitlementVersion, c.entitlementVersion) ||
      !sameVersion(e.supplyProfileVersion, c.supplyProfileVersion) ||
      !sameVersion(e.modelScopeVersion, c.modelScopeVersion) ||
      !e.allowedModels.includes(input.publicModel) ||
      !c.modelScopes.includes(input.publicModel)
    )
      fail('SNAPSHOT_DENIED');
    if (
      r.tenantId !== c.tenantId ||
      r.projectId !== c.projectId ||
      r.publicModel !== input.publicModel ||
      r.protocol !== input.protocol ||
      (r.providerProtocol ?? r.protocol) !== input.protocol ||
      (r.clientOperation ?? 'chat.completions') !== input.clientOperation
    )
      fail('SNAPSHOT_DENIED');
    if (
      !Array.isArray(p.absoluteExpiryMs) ||
      p.absoluteExpiryMs.some((expiry) => !positive(expiry) || expiry <= now || snapshot.validUntilMs > expiry)
    )
      fail('SNAPSHOT_DENIED');
    if (
      !positive(p.maxBodyBytes) ||
      (input.inputByteLength !== undefined &&
        (!Number.isSafeInteger(input.inputByteLength) ||
          input.inputByteLength < 0 ||
          input.inputByteLength > p.maxBodyBytes))
    )
      fail('SNAPSHOT_DENIED');
    const ip = canonicalizeIpPolicy(p.ipPolicy);
    if (ip.mode === 'disabled' && ip.rules.length !== 0) fail('SNAPSHOT_UNAVAILABLE');
    if (
      ip.mode !== 'disabled' &&
      !isIpAllowed(input.clientAddress?.status === 'resolved' ? input.clientAddress.address : null, ip)
    )
      fail('SNAPSHOT_DENIED');
    assertLimit(snapshot.limits.tenant);
    assertLimit(snapshot.limits.project);
    assertLimit(snapshot.limits.key);
    if (
      snapshot.limits.group &&
      (!text(snapshot.limits.group.id) ||
        p.groupStatus !== 'active' ||
        (snapshot.limits.group.rpm !== null &&
          (!Number.isSafeInteger(snapshot.limits.group.rpm) || snapshot.limits.group.rpm < 0)))
    )
      fail('SNAPSHOT_UNAVAILABLE');
    if (!Array.isArray(snapshot.candidates) || snapshot.candidates.length === 0 || snapshot.candidates.length > 256)
      fail('SNAPSHOT_UNAVAILABLE');
    for (const candidate of snapshot.candidates) assertCandidate(candidate, snapshot, now);
  } catch (error) {
    if (error instanceof FastGatewaySnapshotError) throw error;
    fail('SNAPSHOT_UNAVAILABLE');
  }
}
function assertCandidate(candidate: FastGatewayCandidate, snapshot: FastGatewaySnapshot, now: number): void {
  const a = candidate.authority;
  const c = candidate.credential;
  const byok = snapshot.caller.supplyMode === 'byok';
  const tenant = byok ? snapshot.caller.tenantId : null;
  if (snapshot.authority.route.targetMode !== (byok ? 'tenant_account' : 'platform_pool')) fail('SNAPSHOT_DENIED');
  for (const timed of [c.version, candidate.customerPrice, candidate.supplierCost]) {
    if (timed?.expiresAt !== null && timed?.expiresAt !== undefined) {
      const expiry = Date.parse(timed.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now || snapshot.validUntilMs > expiry) fail('SNAPSHOT_DENIED');
    }
  }
  for (const price of [candidate.customerPrice, candidate.supplierCost]) {
    if (price && !(Date.parse(price.effectiveAt) <= now)) fail('SNAPSHOT_DENIED');
  }
  const owner = byok ? 'tenant' : 'platform';
  if (
    a.tenantId !== snapshot.caller.tenantId ||
    a.projectId !== snapshot.caller.projectId ||
    a.proxyKeyId !== snapshot.caller.proxyKeyId ||
    a.supplyProfileId !== snapshot.caller.supplyProfileId ||
    a.protocol !== snapshot.authority.route.protocol ||
    a.endpoint !== snapshot.authority.route.endpoint ||
    !sameVersion(a.supplyProfileAuthzVersion, snapshot.caller.supplyProfileVersion)
  )
    fail('SNAPSHOT_DENIED');
  if (
    a.accountOwnerKind !== owner ||
    a.supplyMode !== snapshot.caller.supplyMode ||
    c.account.ownerKind !== owner ||
    c.account.tenantId !== tenant ||
    c.account.supplyMode !== snapshot.caller.supplyMode ||
    c.account.id !== a.accountId ||
    c.account.providerId !== a.providerId ||
    c.account.productId !== a.productId ||
    c.credential.ownerKind !== owner ||
    c.credential.supplyMode !== snapshot.caller.supplyMode ||
    c.credential.tenantId !== tenant ||
    c.credential.accountId !== a.accountId ||
    c.credential.providerId !== a.providerId ||
    c.credential.productId !== a.productId ||
    c.credential.id !== a.credentialId ||
    c.version.ownerKind !== owner ||
    c.version.tenantId !== tenant ||
    c.version.accountId !== a.accountId ||
    c.version.credentialId !== a.credentialId ||
    !sameVersion(c.version.version, a.credentialVersion) ||
    c.version.status !== 'active' ||
    !c.version.envelope
  )
    fail('SNAPSHOT_DENIED');
  if (
    !positive(candidate.limits.concurrency) ||
    (candidate.limits.rpm !== null && !positive(candidate.limits.rpm)) ||
    (candidate.limits.tpm !== null && !positive(candidate.limits.tpm))
  )
    fail('SNAPSHOT_UNAVAILABLE');
  if (
    candidate.customerPrice &&
    (candidate.customerPrice.id !== snapshot.authority.commercial.customerPriceVersion ||
      candidate.customerPrice.publicModelId !== snapshot.authority.route.publicModelId ||
      !sameVersion(candidate.customerPrice.publicModelVersion, snapshot.authority.route.publicModelVersion) ||
      candidate.customerPrice.providerId !== a.providerId ||
      candidate.customerPrice.productId !== a.productId ||
      candidate.customerPrice.protocol !== a.protocol ||
      candidate.customerPrice.endpoint !== a.endpoint)
  )
    fail('SNAPSHOT_DENIED');
  if (
    candidate.supplierCost &&
    (candidate.supplierCost.id !== a.supplierCostVersion ||
      candidate.supplierCost.providerId !== a.providerId ||
      candidate.supplierCost.productId !== a.productId ||
      candidate.supplierCost.protocol !== a.protocol ||
      candidate.supplierCost.endpoint !== a.endpoint ||
      candidate.supplierCost.resolvedModel !== a.resolvedModel)
  )
    fail('SNAPSHOT_DENIED');
  if (
    byok
      ? candidate.customerPrice !== null || candidate.supplierCost !== null
      : candidate.customerPrice === null || candidate.supplierCost === null
  )
    fail('SNAPSHOT_DENIED');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Authoritative opt-in cache. Positive hits perform zero PostgreSQL operations. */
export class CachedFastGatewaySnapshots implements FastGatewaySnapshotProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly ttl: number;
  private readonly negativeTtl: number;
  private readonly maxEntries: number;
  private readonly maxPending: number;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly key: Buffer | undefined;
  private epoch = 0n;
  private unavailable = false;
  constructor(
    private readonly source: FastGatewaySnapshotProvider,
    private readonly options: FastGatewaySnapshotCacheOptions = {},
  ) {
    this.ttl = options.ttlMs ?? 5000;
    this.negativeTtl = options.negativeTtlMs ?? 500;
    this.maxEntries = options.maxEntries ?? 4096;
    this.maxPending = options.maxPending ?? 64;
    this.timeout = options.loadTimeoutMs ?? 3000;
    this.maxBytes = options.maxCacheBytes ?? 2 * 1024 * 1024;
    this.mono = options.monotonicNow ?? (() => performance.now());
    const wallClock = options.wallNow ?? Date.now;
    let anchorWall = wallClock();
    let anchorMono = this.mono();
    this.wall = () => {
      const mono = this.mono();
      const wall = wallClock();
      if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < anchorMono) fail('SNAPSHOT_UNAVAILABLE');
      anchorWall = Math.max(wall, anchorWall + mono - anchorMono);
      anchorMono = mono;
      return anchorWall;
    };
    if (
      ![this.ttl, this.negativeTtl, this.maxEntries, this.maxPending, this.timeout, this.maxBytes].every(positive) ||
      this.ttl > MAX_TTL_MS ||
      this.negativeTtl > this.ttl ||
      (options.store && options.encryptionKey?.byteLength !== 32) ||
      (options.namespace !== undefined && !/^[a-zA-Z0-9:_-]{1,128}$/.test(options.namespace))
    )
      throw new TypeError('Invalid fast snapshot cache options');
    this.key = options.encryptionKey ? Buffer.from(options.encryptionKey) : undefined;
  }
  /** Durable-outbox consumers call this with a monotonic committed change sequence. */
  invalidate(changeEpoch: bigint | string): void {
    let next: bigint;
    try {
      next = BigInt(changeEpoch);
    } catch {
      fail('SNAPSHOT_UNAVAILABLE');
    }
    if (next < 0n) fail('SNAPSHOT_UNAVAILABLE');
    if (next <= this.epoch) return;
    this.epoch = next;
    this.entries.clear();
    this.metric('invalidated');
  }
  /** A detected Redis/outbox outage closes admission immediately, including L1. */
  markUnavailable(): void {
    this.unavailable = true;
    this.entries.clear();
  }
  /** Recovery requires an externally verified durable epoch; never self-recover from a GET. */
  recover(changeEpoch: bigint | string): void {
    let recovered: bigint;
    try {
      recovered = BigInt(changeEpoch);
    } catch {
      fail('SNAPSHOT_UNAVAILABLE');
    }
    if (recovered < this.epoch) fail('SNAPSHOT_UNAVAILABLE');
    this.invalidate(recovered);
    this.unavailable = false;
  }
  async resolve(input: FastGatewaySnapshotInput): Promise<FastGatewaySnapshot | null> {
    if (this.unavailable) fail('SNAPSHOT_UNAVAILABLE');
    const cacheKey = fastGatewaySnapshotCacheKey(input, this.options.namespace);
    let entry = this.entries.get(cacheKey);
    if (entry && this.live(entry)) {
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, entry);
      this.metric(entry.value ? 'l1_hit' : 'negative_hit');
      return this.use(entry, input);
    }
    this.entries.delete(cacheKey);
    let work = this.pending.get(cacheKey);
    if (work) this.metric('coalesced');
    else {
      if (this.pending.size >= this.maxPending) fail('SNAPSHOT_BUSY');
      const epoch = this.epoch;
      work = this.load(cacheKey, input, epoch);
      this.pending.set(cacheKey, work);
      void work
        .finally(() => {
          if (this.pending.get(cacheKey) === work) this.pending.delete(cacheKey);
        })
        .catch(() => {});
    }
    entry = await this.wait(work);
    return this.use(entry, input);
  }
  private metric(value: FastGatewaySnapshotMetric): void {
    try {
      this.options.observe?.(value);
    } catch {
      /* metrics cannot change authority */
    }
  }
  private live(entry: Entry): boolean {
    return (
      !this.unavailable && entry.epoch === this.epoch && entry.until > this.mono() && entry.wallUntil > this.wall()
    );
  }
  private use(entry: Entry, input: FastGatewaySnapshotInput): FastGatewaySnapshot | null {
    if (!this.live(entry)) fail('SNAPSHOT_UNAVAILABLE');
    if (entry.value) {
      try {
        authorizeFastGatewaySnapshot(entry.value, input, this.wall());
      } catch (error) {
        this.metric('denied');
        throw error;
      }
    }
    return entry.value;
  }
  private async wait(work: Promise<Entry>): Promise<Entry> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new FastGatewaySnapshotError('SNAPSHOT_UNAVAILABLE')), this.timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async load(cacheKey: string, input: FastGatewaySnapshotInput, epoch: bigint): Promise<Entry> {
    const startMono = this.mono();
    const startWall = this.wall();
    try {
      if (this.options.store) {
        let bytes: Buffer | null;
        try {
          bytes = await this.options.store.get(cacheKey);
        } catch {
          this.markUnavailable();
          return fail('SNAPSHOT_UNAVAILABLE');
        }
        if (bytes) {
          const stored = this.decode(bytes, cacheKey);
          if (
            stored.epoch === epoch &&
            stored.value &&
            stored.value.observedAtMs <= startWall &&
            stored.value.validUntilMs > this.wall()
          ) {
            const entry = this.makeEntry(stored.value, epoch, startWall, startMono);
            this.storeEntry(cacheKey, entry);
            this.metric('l2_hit');
            return entry;
          }
        }
      }
      this.metric('cold_load');
      const value = await this.source.resolve(input);
      if (this.mono() - startMono >= this.timeout || this.epoch !== epoch || this.unavailable)
        fail('SNAPSHOT_UNAVAILABLE');
      if (value && value.observedAtMs > this.wall()) fail('SNAPSHOT_UNAVAILABLE');
      const entry = this.makeEntry(value, epoch, startWall, startMono);
      if (entry.value && this.options.store) {
        const bytes = this.encode(entry.value, epoch, cacheKey);
        try {
          await this.options.store.set(cacheKey, bytes, Math.max(1, Math.floor(entry.wallUntil - this.wall())));
        } catch {
          this.markUnavailable();
          return fail('SNAPSHOT_UNAVAILABLE');
        }
      }
      if (!this.live(entry)) fail('SNAPSHOT_UNAVAILABLE');
      this.storeEntry(cacheKey, entry);
      return entry;
    } catch (error) {
      this.metric('unavailable');
      if (error instanceof FastGatewaySnapshotError) throw error;
      fail('SNAPSHOT_UNAVAILABLE');
    }
  }
  private makeEntry(value: FastGatewaySnapshot | null, epoch: bigint, startWall: number, startMono: number): Entry {
    if (!value)
      return { value: null, epoch, until: startMono + this.negativeTtl, wallUntil: startWall + this.negativeTtl };
    const caps = value.policy?.absoluteExpiryMs;
    if (!Array.isArray(caps) || caps.some((n) => !positive(n))) fail('SNAPSHOT_UNAVAILABLE');
    const wallUntil = Math.min(value.validUntilMs, value.observedAtMs + this.ttl, ...caps);
    if (!Number.isSafeInteger(wallUntil) || wallUntil <= this.wall()) fail('SNAPSHOT_UNAVAILABLE');
    const frozen = freeze(structuredClone({ ...value, validUntilMs: wallUntil }));
    // Elapsed local time, including network/load latency, cannot be renewed by a wall-clock rollback.
    const entry = { value: frozen, epoch, wallUntil, until: startMono + Math.max(0, wallUntil - startWall) };
    localSnapshotLeases.set(frozen, () => {
      if (!this.live(entry)) fail('SNAPSHOT_UNAVAILABLE');
      return this.wall();
    });
    return entry;
  }
  private storeEntry(cacheKey: string, entry: Entry): void {
    if (!this.live(entry)) fail('SNAPSHOT_UNAVAILABLE');
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(cacheKey, entry);
  }
  private encode(value: FastGatewaySnapshot, epoch: bigint, cacheKey: string): Buffer {
    const plaintext = serialize({ version: 1, epoch, value });
    if (plaintext.length > this.maxBytes || !this.key) fail('SNAPSHOT_UNAVAILABLE');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(cacheKey));
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }
  private decode(bytes: Buffer, cacheKey: string): { epoch: bigint; value: FastGatewaySnapshot } {
    if (!this.key || bytes.length < 29 || bytes.length > this.maxBytes + 28) fail('SNAPSHOT_UNAVAILABLE');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(cacheKey));
      decipher.setAuthTag(bytes.subarray(-16));
      const decoded = deserialize(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]));
      if (decoded?.version !== 1 || typeof decoded.epoch !== 'bigint' || !decoded.value) fail('SNAPSHOT_UNAVAILABLE');
      return decoded;
    } catch {
      return fail('SNAPSHOT_UNAVAILABLE');
    }
  }
}
