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
  /** Frozen deployment policy captured only by the cold source; never resolved per send. */
  readonly dispatch?: {
    readonly authenticationHeader: { readonly headerName: string; readonly valueFormat?: 'raw' | 'bearer' };
    readonly modelCompatibility: {
      readonly providerId: string;
      readonly productId: string;
      readonly providerModel: string;
      readonly providerProtocol: string;
    };
  };
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
  /** Admission handoff headroom, never an extension of the original authority lease. */
  readonly minimumValidityMs?: number;
  /** Begin one cold refresh before handoff headroom is exhausted. */
  readonly refreshAheadMs?: number;
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
  readonly cacheKey: string;
  readonly rejectionSequence: bigint;
  readonly denied?: boolean;
  readonly value: FastGatewaySnapshot | null;
  readonly until: number;
  readonly wallUntil: number;
  readonly epoch: bigint;
};
const MAX_TTL_MS = 5_000;
// A soft handoff miss is not an authority failure. Only the warm lookup may
// join its existing refresh; all expiry, revocation and dependency errors throw.
const HANDOFF_REFRESH_REQUIRED = Symbol('handoff-refresh-required');
// The immutable object, not a caller-supplied timestamp, carries its local lease.
// Post-intent authorization can therefore recheck epoch/outage/monotonic expiry
// without any database or Redis read. Weak keys do not retain evicted snapshots.
const localSnapshotLeases = new WeakMap<FastGatewaySnapshot, () => number>();
// Only makeEntry's owned clone can acquire a proof, and only after a complete
// successful authorization. Object.freeze on an arbitrary caller object is not
// provenance: nested objects or accessors could still change. Weak keys neither
// retain evicted snapshots nor turn this structural proof into a renewed lease.
type CandidateTimeFacts = { readonly expiresAtMs: number; readonly effectiveAtMs: number };
const localSnapshotStaticProofs = new WeakMap<
  FastGatewaySnapshot,
  {
    readonly ipPolicy: Readonly<IpPolicy>;
    readonly candidateTimes: readonly (CandidateTimeFacts | undefined)[];
  }
>();
type VersionPrimitive = string | number | bigint;
type RequestParseFacts = {
  readonly versions: Map<VersionPrimitive, string>;
  expiry?: { readonly source: string; readonly parsed: number };
};
// Parsing facts, never authorization decisions. Each expression still reads its
// current raw value before consulting this request-local, bounded memo. Objects
// (including stateful coercions/proxies) are deliberately never memoized. Weak
// keys do not retain requests, callers, credentials or snapshots after use.
const requestParseFacts = new WeakMap<FastGatewaySnapshotInput, RequestParseFacts>();
const MAX_REQUEST_VERSION_FACTS = 16;
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
function sameVersion(a: unknown, b: unknown, facts?: RequestParseFacts): boolean {
  return facts ? requestVersion(a, facts) === requestVersion(b, facts) : version(a) === version(b);
}
function requestVersion(value: unknown, facts: RequestParseFacts): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return version(value);
  const cached = facts.versions.get(value);
  if (cached !== undefined) return cached;
  const parsed = version(value);
  if (facts.versions.size >= MAX_REQUEST_VERSION_FACTS) facts.versions.clear();
  facts.versions.set(value, parsed);
  return parsed;
}
function requestExpiry(value: string, facts: RequestParseFacts | undefined): number {
  if (!facts || typeof value !== 'string') return Date.parse(value);
  if (facts.expiry?.source === value) return facts.expiry.parsed;
  const parsed = Date.parse(value);
  facts.expiry = { source: value, parsed };
  return parsed;
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
    const staticProof = localSnapshotStaticProofs.get(snapshot);
    let parseFacts: RequestParseFacts | undefined;
    if (lease) {
      parseFacts = requestParseFacts.get(input);
      if (!parseFacts) {
        parseFacts = { versions: new Map() };
        requestParseFacts.set(input, parseFacts);
      }
    }
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
      (m.expiresAt !== null && !(requestExpiry(m.expiresAt, parseFacts) > now))
    )
      fail('SNAPSHOT_DENIED');
    if (
      m.executionPrincipalType !== a.principalKind ||
      m.executionPrincipalId !== a.principalId ||
      m.entitlementId !== a.entitlementId ||
      m.supplyProfileId !== a.supplyProfileId ||
      m.supplyMode !== a.supplyMode ||
      !sameSet(m.modelScopes, a.modelScopes) ||
      !sameVersion(m.authzVersion, a.authzVersion, parseFacts) ||
      !sameVersion(m.modelScopeVersion, a.modelScopeVersion, parseFacts) ||
      !sameVersion(m.entitlementAuthzVersion, a.entitlementAuthzVersion, parseFacts) ||
      !sameVersion(m.supplyProfileAuthzVersion, a.supplyProfileAuthzVersion, parseFacts)
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
      !sameVersion(c.authzVersion, a.authzVersion, parseFacts) ||
      !sameVersion(c.modelScopeVersion, a.modelScopeVersion, parseFacts) ||
      !sameVersion(c.entitlementVersion, a.entitlementAuthzVersion, parseFacts) ||
      !sameVersion(c.supplyProfileVersion, a.supplyProfileAuthzVersion, parseFacts)
    )
      fail('SNAPSHOT_DENIED');
    if (
      (!staticProof &&
        (e.tenantId !== c.tenantId ||
          e.projectId !== c.projectId ||
          e.proxyKeyId !== c.proxyKeyId ||
          e.entitlementId !== c.entitlementId ||
          e.supplyProfileId !== c.supplyProfileId ||
          e.supplyMode !== c.supplyMode ||
          !sameVersion(e.entitlementVersion, c.entitlementVersion) ||
          !sameVersion(e.supplyProfileVersion, c.supplyProfileVersion) ||
          !sameVersion(e.modelScopeVersion, c.modelScopeVersion))) ||
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
    const ip = staticProof?.ipPolicy ?? canonicalizeIpPolicy(p.ipPolicy);
    if (ip.mode === 'disabled' && ip.rules.length !== 0) fail('SNAPSHOT_UNAVAILABLE');
    if (
      ip.mode !== 'disabled' &&
      !isIpAllowed(input.clientAddress?.status === 'resolved' ? input.clientAddress.address : null, ip)
    )
      fail('SNAPSHOT_DENIED');
    if (!staticProof) {
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
    }
    const candidateTimes: (CandidateTimeFacts | undefined)[] | undefined = lease && !staticProof ? [] : undefined;
    let candidateIndex = 0;
    for (const candidate of snapshot.candidates) {
      const times = assertCandidate(
        candidate,
        snapshot,
        now,
        staticProof !== undefined,
        staticProof?.candidateTimes[candidateIndex++],
      );
      candidateTimes?.push(times);
    }
    if (candidateTimes)
      localSnapshotStaticProofs.set(snapshot, { ipPolicy: freeze(ip), candidateTimes: freeze(candidateTimes) });
  } catch (error) {
    if (error instanceof FastGatewaySnapshotError) throw error;
    fail('SNAPSHOT_UNAVAILABLE');
  }
}
function assertCandidate(
  candidate: FastGatewayCandidate,
  snapshot: FastGatewaySnapshot,
  now: number,
  staticValidated: boolean,
  timeFacts: CandidateTimeFacts | undefined,
): CandidateTimeFacts | undefined {
  const a = candidate.authority;
  const c = candidate.credential;
  const byok = snapshot.caller.supplyMode === 'byok';
  const tenant = byok ? snapshot.caller.tenantId : null;
  if (!staticValidated && snapshot.authority.route.targetMode !== (byok ? 'tenant_account' : 'platform_pool'))
    fail('SNAPSHOT_DENIED');
  if (!timeFacts) {
    let expiresAtMs = Infinity;
    let effectiveAtMs = -Infinity;
    let primitiveTimes = true;
    for (const timed of [c.version, candidate.customerPrice, candidate.supplierCost]) {
      if (timed?.expiresAt !== null && timed?.expiresAt !== undefined) {
        const source = timed.expiresAt;
        const expiry = Date.parse(source);
        if (!Number.isFinite(expiry) || expiry <= now || snapshot.validUntilMs > expiry) fail('SNAPSHOT_DENIED');
        expiresAtMs = Math.min(expiresAtMs, expiry);
        primitiveTimes &&= typeof source === 'string';
      }
    }
    for (const price of [candidate.customerPrice, candidate.supplierCost]) {
      if (price) {
        const source = price.effectiveAt;
        const effective = Date.parse(source);
        if (!(effective <= now)) fail('SNAPSHOT_DENIED');
        effectiveAtMs = Math.max(effectiveAtMs, effective);
        primitiveTimes &&= typeof source === 'string';
      }
    }
    // Frozen Date instances still have mutable internal slots. Retain the old
    // per-use parsing path for any runtime non-string instead of trusting the
    // TypeScript annotation or object freezing to make its coercion immutable.
    if (primitiveTimes) timeFacts = { expiresAtMs, effectiveAtMs };
  } else {
    // Only parsing is reused. These equivalent bounds cover every candidate's
    // credential/price dates and are compared to live lease-anchored time at
    // EVERY boundary, including pre-send and credential-unseal callbacks.
    if (
      timeFacts.expiresAtMs <= now ||
      snapshot.validUntilMs > timeFacts.expiresAtMs ||
      !(timeFacts.effectiveAtMs <= now)
    )
      fail('SNAPSHOT_DENIED');
  }
  if (staticValidated) return timeFacts;
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
  return timeFacts;
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
  // Keep known-deny barriers for one maximum lease lifetime, including held
  // objects no longer in L1. A later source validation can mint a new lease;
  // a stale L2 value cannot. This map is bounded independently of request rate.
  private readonly rejections = new Map<string, { sequence: bigint; until: number }>();
  private rejectionSequence = 0n;
  private readonly ttl: number;
  private readonly negativeTtl: number;
  private readonly minimumValidity: number;
  private readonly refreshAhead: number;
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
    this.minimumValidity = options.minimumValidityMs ?? 0;
    this.refreshAhead = options.refreshAheadMs ?? this.minimumValidity;
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
      !Number.isSafeInteger(this.minimumValidity) ||
      this.minimumValidity < 0 ||
      !Number.isSafeInteger(this.refreshAhead) ||
      this.refreshAhead < this.minimumValidity ||
      this.refreshAhead >= this.ttl ||
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
  /** Health lane observation only; a successful probe cannot recover this latch. */
  isAvailable(): boolean {
    return !this.unavailable;
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
    if (entry && this.usable(entry)) {
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, entry);
      this.metric(entry.value ? 'l1_hit' : 'negative_hit');
      if (entry.value && this.remaining(entry) <= this.refreshAhead) {
        // No stale lease is renewed; the old object retains its original deadline.
        void this.startLoad(cacheKey, input, true).catch(() => {});
      }
      const value = this.use(entry, input);
      if (value !== HANDOFF_REFRESH_REQUIRED) return value;
      // Time can cross minimumValidity while starting refresh-ahead. Join that
      // single flight before any Redis/financial side effect, never renew the
      // held lease or retry a thrown denial/outage/invalidation.
    }
    this.entries.delete(cacheKey);
    const work = this.startLoad(cacheKey, input, entry !== undefined);
    entry = await this.wait(work);
    const value = this.use(entry, input);
    if (value === HANDOFF_REFRESH_REQUIRED) fail('SNAPSHOT_UNAVAILABLE');
    return value;
  }
  private startLoad(cacheKey: string, input: FastGatewaySnapshotInput, bypassL2: boolean): Promise<Entry> {
    let work = this.pending.get(cacheKey);
    if (work) this.metric('coalesced');
    else {
      if (this.pending.size >= this.maxPending) return Promise.reject(new FastGatewaySnapshotError('SNAPSHOT_BUSY'));
      try {
        const scope = this.retainScope(cacheKey);
        work = this.load(cacheKey, input, this.epoch, bypassL2 || scope.sequence > 0n);
      } catch (error) {
        return Promise.reject(error);
      }
      this.pending.set(cacheKey, work);
      void work
        .finally(() => {
          if (this.pending.get(cacheKey) === work) this.pending.delete(cacheKey);
        })
        .catch(() => {});
    }
    return work;
  }
  private rejection(cacheKey: string): { sequence: bigint; until: number } | undefined {
    const rejection = this.rejections.get(cacheKey);
    if (rejection && rejection.until <= this.mono()) {
      this.rejections.delete(cacheKey);
      return undefined;
    }
    return rejection;
  }
  private retainScope(cacheKey: string): { sequence: bigint; until: number } {
    let scope = this.rejection(cacheKey);
    if (!scope) {
      if (this.rejections.size >= this.maxEntries + this.maxPending) {
        for (const key of this.rejections.keys()) this.rejection(key);
        if (this.rejections.size >= this.maxEntries + this.maxPending) fail('SNAPSHOT_BUSY');
      }
      scope = { sequence: 0n, until: 0 };
      this.rejections.set(cacheKey, scope);
    }
    // Retain through all possible issued leases, even if L1 evicts the scope.
    // This only bounds bookkeeping: it never changes an entry's hard expiry.
    scope.until = Math.max(scope.until, this.mono() + this.timeout + this.ttl);
    return scope;
  }
  private rejectScope(cacheKey: string): void {
    const scope = this.retainScope(cacheKey);
    scope.sequence = ++this.rejectionSequence;
    this.entries.delete(cacheKey);
  }
  private remaining(entry: Entry): number {
    return Math.min(entry.until - this.mono(), entry.wallUntil - this.wall());
  }
  private usable(entry: Entry): boolean {
    return this.live(entry) && (entry.value === null || this.remaining(entry) > this.minimumValidity);
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
      !this.unavailable &&
      entry.epoch === this.epoch &&
      entry.until > this.mono() &&
      entry.wallUntil > this.wall() &&
      (this.rejection(entry.cacheKey)?.sequence ?? 0n) <= entry.rejectionSequence
    );
  }
  private use(
    entry: Entry,
    input: FastGatewaySnapshotInput,
  ): FastGatewaySnapshot | null | typeof HANDOFF_REFRESH_REQUIRED {
    if (!this.live(entry)) fail('SNAPSHOT_UNAVAILABLE');
    if (entry.denied) fail('SNAPSHOT_DENIED');
    if (entry.value && this.remaining(entry) <= this.minimumValidity) return HANDOFF_REFRESH_REQUIRED;
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
  private async load(
    cacheKey: string,
    input: FastGatewaySnapshotInput,
    epoch: bigint,
    bypassL2 = false,
  ): Promise<Entry> {
    const startMono = this.mono();
    const startWall = this.wall();
    try {
      if (this.options.store && !bypassL2) {
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
            stored.value.validUntilMs - this.wall() > this.minimumValidity &&
            stored.value.observedAtMs + this.ttl - this.wall() > this.minimumValidity
          ) {
            const entry = this.makeEntry(stored.value, epoch, startWall, startMono, cacheKey);
            this.storeEntry(cacheKey, entry);
            this.metric('l2_hit');
            return entry;
          }
        }
      }
      this.metric('cold_load');
      let value: FastGatewaySnapshot | null;
      try {
        value = await this.source.resolve(input);
      } catch (error) {
        // Only the source's explicit authority denial is revocation evidence.
        // Timeouts/network/storage faults keep their existing bounded policy.
        if (
          error instanceof FastGatewaySnapshotError &&
          error.code === 'SNAPSHOT_DENIED' &&
          this.epoch === epoch &&
          !this.unavailable
        ) {
          this.rejectScope(cacheKey);
          const denied = { ...this.makeEntry(null, epoch, this.wall(), this.mono(), cacheKey), denied: true };
          this.storeEntry(cacheKey, denied);
          return denied;
        }
        throw error;
      }
      // Known unsupported authority fences held tickets even if this cold read
      // ran past its wait budget. Never publish an expired result or fence a
      // newer global epoch on behalf of the obsolete load.
      if (value === null && this.epoch === epoch && !this.unavailable) this.rejectScope(cacheKey);
      if (this.mono() - startMono >= this.timeout || this.epoch !== epoch || this.unavailable)
        fail('SNAPSHOT_UNAVAILABLE');
      if (value && value.observedAtMs > this.wall()) fail('SNAPSHOT_UNAVAILABLE');
      const entry = this.makeEntry(value, epoch, startWall, startMono, cacheKey);
      if (entry.value && this.options.store) {
        const bytes = this.encode(entry.value, epoch, cacheKey);
        try {
          await this.options.store.set(cacheKey, bytes, Math.max(1, Math.floor(entry.wallUntil - this.wall())));
        } catch {
          this.markUnavailable();
          return fail('SNAPSHOT_UNAVAILABLE');
        }
      }
      if (!this.usable(entry)) fail('SNAPSHOT_UNAVAILABLE');
      this.storeEntry(cacheKey, entry);
      return entry;
    } catch (error) {
      this.metric('unavailable');
      if (error instanceof FastGatewaySnapshotError) throw error;
      fail('SNAPSHOT_UNAVAILABLE');
    }
  }
  private makeEntry(
    value: FastGatewaySnapshot | null,
    epoch: bigint,
    startWall: number,
    startMono: number,
    cacheKey: string,
  ): Entry {
    const scope = { cacheKey, rejectionSequence: this.rejection(cacheKey)?.sequence ?? 0n };
    if (!value)
      return {
        ...scope,
        value: null,
        epoch,
        until: startMono + this.negativeTtl,
        wallUntil: startWall + this.negativeTtl,
      };
    const caps = value.policy?.absoluteExpiryMs;
    if (!Array.isArray(caps) || caps.some((n) => !positive(n))) fail('SNAPSHOT_UNAVAILABLE');
    const wallUntil = Math.min(value.validUntilMs, value.observedAtMs + this.ttl, ...caps);
    if (!Number.isSafeInteger(wallUntil) || wallUntil <= this.wall()) fail('SNAPSHOT_UNAVAILABLE');
    const frozen = freeze(structuredClone({ ...value, validUntilMs: wallUntil }));
    // Elapsed local time, including network/load latency, cannot be renewed by a wall-clock rollback.
    const entry = { ...scope, value: frozen, epoch, wallUntil, until: startMono + Math.max(0, wallUntil - startWall) };
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
