import { createHash } from 'node:crypto';
import { candidateMatchesScope, type GatewayProtocol, type SupplyMode } from './contracts.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationCaller,
  type RequestPreparationCandidateAuthority,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  type RequestPreparationRouteAuthority,
  type RequestPreparationSchedulingContext,
  rejectRequestPreparation,
} from './request-preparation-service.js';

/**
 * This scheduler is deliberately a pre-lease selector. It never treats a
 * health or concurrency snapshot as permission to send traffic: the durable
 * request/attempt authority and the fenced provider-account lease remain the
 * final dispatch guards.
 */

export interface ProviderAccountSchedulerRights {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly status: 'active';
  readonly version: string | number;
  readonly effectiveAt?: string | Date | null;
  readonly expiresAt?: string | Date | null;
}

export interface ProviderAccountSchedulerEligibilityAllowed {
  readonly decision: 'allow';
  /** The same account identity, with freshly revalidated non-secret epochs. */
  readonly candidate: RequestPreparationCandidateAuthority;
  readonly status: 'active';
  readonly capability: {
    readonly protocol: GatewayProtocol;
    readonly supportLevel: 'supported' | 'limited';
    readonly validationState: 'verified' | 'unverified';
  };
  readonly rights: ProviderAccountSchedulerRights;
  /** Current route identity read by the same authority that revalidated this candidate. */
  readonly route?: ProviderAccountSchedulerRevalidatedRoute;
  /** Higher values are preferred before load balancing is applied. */
  readonly priority: number;
  /** Positive integer used by deterministic weighted choice. */
  readonly weight: number;
}

export interface ProviderAccountSchedulerRevalidatedRoute {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly supplyMode: SupplyMode;
  readonly targetMode: 'tenant_account' | 'platform_pool';
  readonly upstreamId: string;
  readonly providerId: string;
  readonly productId: string;
}

/** Secret-free scope facts used by durable affinity storage. */
export interface ProviderAccountSchedulerAffinityScope extends ProviderAccountSchedulerRevalidatedRoute {
  readonly supplyProfileId: string;
  readonly accountOwnerKind: 'tenant' | 'platform';
}

export interface ProviderAccountSchedulerEligibilityDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerEligibilityBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerEligibilityDecision =
  | ProviderAccountSchedulerEligibilityAllowed
  | ProviderAccountSchedulerEligibilityDenied
  | ProviderAccountSchedulerEligibilityBlocked;

export interface ProviderAccountSchedulerEligibilityPort {
  /**
   * Re-checks the candidate's account, credential, capability, and Provider
   * rights immediately before selection. A deny removes only this candidate;
   * an unavailable authority blocks the whole selection.
   */
  revalidate(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly route?: RequestPreparationRouteAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerEligibilityDecision>;
}

export interface ProviderAccountSchedulerHealthAllowed {
  readonly decision: 'allow';
  readonly value: {
    readonly status: 'healthy' | 'degraded' | 'cooldown' | 'unhealthy';
    readonly observedAt: string | Date;
    readonly cooldownUntil?: string | Date | null;
  };
}

export interface ProviderAccountSchedulerHealthDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerHealthBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerHealthDecision =
  | ProviderAccountSchedulerHealthAllowed
  | ProviderAccountSchedulerHealthDenied
  | ProviderAccountSchedulerHealthBlocked;

export interface ProviderAccountSchedulerHealthPort {
  /** Missing, stale, or unavailable distributed health state must block. */
  get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerHealthDecision>;
}

export interface ProviderAccountSchedulerConcurrencyAllowed {
  readonly decision: 'allow';
  readonly value: {
    /** This is a preflight observation, never the final lease decision. */
    readonly inFlight: number;
    readonly limit: number;
  };
}

export interface ProviderAccountSchedulerConcurrencyDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerConcurrencyBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerConcurrencyDecision =
  | ProviderAccountSchedulerConcurrencyAllowed
  | ProviderAccountSchedulerConcurrencyDenied
  | ProviderAccountSchedulerConcurrencyBlocked;

export interface ProviderAccountSchedulerConcurrencyPort {
  /**
   * Reads a bounded, fail-closed capacity snapshot. The caller must still
   * acquire the fenced database lease after preparation and before I/O.
   */
  get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerConcurrencyDecision>;
}

export interface ProviderAccountSchedulerAffinityAllowed {
  readonly decision: 'allow';
  /** Null means no valid affinity was found and is not an error. */
  readonly accountId: string | null;
}

export interface ProviderAccountSchedulerAffinityBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerAffinityDecision =
  | ProviderAccountSchedulerAffinityAllowed
  | ProviderAccountSchedulerAffinityBlocked;

export interface ProviderAccountSchedulerAffinityPort {
  /**
   * Resolves only a server-validated opaque affinity reference. The returned
   * account is merely a preference and is checked again against all filters.
   */
  resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly context: RequestPreparationSchedulingContext;
    readonly scope: ProviderAccountSchedulerAffinityScope;
    /** Candidate ids have already passed route, rights, capability, health, and concurrency checks. */
    readonly eligibleAccountIds: readonly string[];
  }): Promise<ProviderAccountSchedulerAffinityDecision>;

  /** Called by request preparation only after it accepts the eligible selection. */
  bind?(input: {
    readonly context: RequestPreparationSchedulingContext;
    readonly scope: ProviderAccountSchedulerAffinityScope;
    readonly accountId: string;
  }): Promise<ProviderAccountSchedulerAffinityBindDecision>;
}

export type ProviderAccountSchedulerAffinityBindDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly reason: string };

export interface ProviderAccountSchedulerAffinityBindingInput {
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly context: RequestPreparationSchedulingContext;
  readonly route: RequestPreparationRouteAuthority;
  readonly candidate: RequestPreparationCandidateAuthority;
}

export interface ProviderAccountSchedulerDependencies {
  /** Optional in the type only so an uncomposed runtime fails closed. */
  readonly eligibility?: ProviderAccountSchedulerEligibilityPort;
  /** Distributed/database-backed health state; no process-local fallback. */
  readonly health?: ProviderAccountSchedulerHealthPort;
  /** Capacity observation; the fenced lease remains the final authority. */
  readonly concurrency?: ProviderAccountSchedulerConcurrencyPort;
  /** Required whenever the request carries an affinity reference. */
  readonly affinity?: ProviderAccountSchedulerAffinityPort;
}

export interface ProviderAccountSchedulerInput {
  readonly requestId: string;
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly candidates: readonly RequestPreparationCandidateAuthority[];
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  /** Server-resolved route identity; required when an affinity key is present. */
  readonly route?: RequestPreparationRouteAuthority;
  readonly scheduling?: RequestPreparationSchedulingContext;
}

export interface ProviderAccountSchedulerPort {
  select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>>;

  /** Persists affinity after preparation accepts the selected candidate. */
  bindAffinity?(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision>;
}

export interface ProviderAccountSchedulerOptions {
  readonly now?: () => Date;
  readonly maxHealthAgeMs?: number;
}

interface EligibleCandidate {
  readonly candidate: RequestPreparationCandidateAuthority;
  readonly priority: number;
  readonly weight: number;
  readonly inFlight: number;
  readonly concurrencyLimit: number;
  readonly healthRank: number;
  readonly accountId: string;
  readonly route?: ProviderAccountSchedulerRevalidatedRoute;
}

const DEFAULT_MAX_HEALTH_AGE_MS = 30_000;
const MAX_HEALTH_AGE_MS = 86_400_000;
const MAX_IDENTIFIER_LENGTH = 512;
const POSITIVE_INTEGER_MAX = 1_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim() && !value.includes('\u0000');
}

function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= POSITIVE_INTEGER_MAX;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= POSITIVE_INTEGER_MAX;
}

function revision(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1;
  if (typeof value === 'string') return /^[1-9][0-9]*$/.test(value);
  return typeof value === 'bigint' && value >= 1n;
}

function revisionText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return String(value);
  if (typeof value === 'bigint' && value >= 1n) return value.toString();
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function withinWindow(value: unknown, now: Date): boolean {
  const effectiveAt = date(value);
  return effectiveAt === null || effectiveAt.getTime() <= now.getTime();
}

function notExpired(value: unknown, now: Date): boolean {
  const expiresAt = date(value);
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

function sameCandidateIdentity(
  original: RequestPreparationCandidateAuthority,
  refreshed: RequestPreparationCandidateAuthority,
): boolean {
  return (
    refreshed.tenantId === original.tenantId &&
    refreshed.projectId === original.projectId &&
    refreshed.proxyKeyId === original.proxyKeyId &&
    refreshed.supplyProfileId === original.supplyProfileId &&
    refreshed.supplyMode === original.supplyMode &&
    refreshed.accountId === original.accountId &&
    refreshed.upstreamId === original.upstreamId &&
    refreshed.credentialId === original.credentialId &&
    refreshed.providerId === original.providerId &&
    refreshed.productId === original.productId &&
    refreshed.resolvedModel === original.resolvedModel &&
    refreshed.protocol === original.protocol &&
    refreshed.endpoint === original.endpoint &&
    refreshed.supplierCostVersion === original.supplierCostVersion
  );
}

function validAffinityContext(context: RequestPreparationSchedulingContext | undefined): boolean {
  if (!context) return true;
  const fields = [context.previousResponseId, context.sessionId].filter((value) => value !== undefined);
  return (
    fields.every((value) => nonEmpty(value) && value.length <= MAX_IDENTIFIER_LENGTH) &&
    (context.attemptedAccountIds === undefined ||
      (Array.isArray(context.attemptedAccountIds) &&
        new Set(context.attemptedAccountIds).size === context.attemptedAccountIds.length &&
        context.attemptedAccountIds.every((value) => nonEmpty(value) && value.length <= MAX_IDENTIFIER_LENGTH))) &&
    (fields.length > 0 || (context.attemptedAccountIds?.length ?? 0) > 0)
  );
}

function hasAffinityReference(context: RequestPreparationSchedulingContext | undefined): boolean {
  return Boolean(context?.previousResponseId !== undefined || context?.sessionId !== undefined);
}

function validRevalidatedRoute(
  route: unknown,
  input: ProviderAccountSchedulerInput,
  candidate: RequestPreparationCandidateAuthority,
): route is ProviderAccountSchedulerRevalidatedRoute {
  if (!isRecord(route)) return false;
  const source = input.route;
  return (
    nonEmpty(route.tenantId) &&
    route.tenantId === input.caller.tenantId &&
    nonEmpty(route.projectId) &&
    route.projectId === input.caller.projectId &&
    nonEmpty(route.routeConfigId) &&
    nonEmpty(route.routeConfigVersion) &&
    revisionText(route.routeConfigVersion) !== null &&
    nonEmpty(route.publicModelId) &&
    nonEmpty(route.publicModelVersion) &&
    revisionText(route.publicModelVersion) !== null &&
    route.publicModel === input.publicModel &&
    route.protocol === input.protocol &&
    route.supplyMode === input.caller.supplyMode &&
    route.targetMode === (input.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool') &&
    nonEmpty(route.upstreamId) &&
    route.upstreamId === candidate.upstreamId &&
    nonEmpty(route.providerId) &&
    route.providerId === candidate.providerId &&
    nonEmpty(route.productId) &&
    route.productId === candidate.productId &&
    (source === undefined ||
      (route.routeConfigId === source.routeConfigId &&
        revisionText(route.routeConfigVersion) === revisionText(source.routeConfigVersion) &&
        route.publicModelId === source.publicModelId &&
        revisionText(route.publicModelVersion) === revisionText(source.publicModelVersion) &&
        route.tenantId === source.tenantId &&
        route.projectId === source.projectId &&
        route.publicModel === source.publicModel &&
        route.protocol === source.protocol &&
        route.supplyMode === input.caller.supplyMode &&
        route.targetMode === source.targetMode &&
        route.upstreamId === source.upstreamId &&
        candidate.endpoint === source.endpoint))
  );
}

function affinityScopeFromSelection(
  input: ProviderAccountSchedulerInput,
  eligible: readonly EligibleCandidate[],
): ProviderAccountSchedulerAffinityScope | null {
  const first = eligible[0];
  if (!first?.route || !validRevalidatedRoute(first.route, input, first.candidate)) return null;
  for (const current of eligible) {
    if (
      !current.route ||
      !validRevalidatedRoute(current.route, input, current.candidate) ||
      current.route.routeConfigId !== first.route.routeConfigId ||
      current.route.routeConfigVersion !== first.route.routeConfigVersion ||
      current.route.publicModelId !== first.route.publicModelId ||
      current.route.publicModelVersion !== first.route.publicModelVersion ||
      current.route.upstreamId !== first.route.upstreamId ||
      current.route.providerId !== first.route.providerId ||
      current.route.productId !== first.route.productId
    ) {
      return null;
    }
  }
  return {
    ...first.route,
    supplyProfileId: input.caller.supplyProfileId,
    accountOwnerKind: input.caller.supplyMode === 'byok' ? 'tenant' : 'platform',
  };
}

function affinityScopeFromBinding(
  input: ProviderAccountSchedulerAffinityBindingInput,
): ProviderAccountSchedulerAffinityScope | null {
  const { caller, entitlement, publicModel, protocol, route, candidate } = input;
  if (
    !nonEmpty(route.routeConfigId) ||
    !revisionText(route.routeConfigVersion) ||
    !nonEmpty(route.publicModelId) ||
    !revisionText(route.publicModelVersion) ||
    !nonEmpty(route.upstreamId) ||
    route.tenantId !== caller.tenantId ||
    route.projectId !== caller.projectId ||
    route.publicModel !== publicModel ||
    route.protocol !== protocol ||
    candidate.tenantId !== caller.tenantId ||
    candidate.projectId !== caller.projectId ||
    candidate.supplyProfileId !== caller.supplyProfileId ||
    candidate.supplyMode !== caller.supplyMode ||
    candidate.supplyMode !== entitlement.supplyMode ||
    candidate.upstreamId !== route.upstreamId ||
    candidate.protocol !== protocol ||
    candidate.providerId === '' ||
    candidate.productId === '' ||
    candidate.endpoint !== route.endpoint ||
    route.targetMode !== (caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool')
  ) {
    return null;
  }
  return {
    tenantId: caller.tenantId,
    projectId: caller.projectId,
    supplyProfileId: caller.supplyProfileId,
    supplyMode: caller.supplyMode,
    routeConfigId: route.routeConfigId,
    routeConfigVersion: revisionText(route.routeConfigVersion) as string,
    publicModelId: route.publicModelId,
    publicModelVersion: revisionText(route.publicModelVersion) as string,
    publicModel,
    protocol,
    targetMode: route.targetMode,
    upstreamId: route.upstreamId,
    providerId: candidate.providerId,
    productId: candidate.productId,
    accountOwnerKind: candidate.accountOwnerKind,
  };
}

function healthStatusRank(status: ProviderAccountSchedulerHealthAllowed['value']['status']): number {
  return status === 'healthy' ? 0 : 1;
}

function healthValue(
  decision: ProviderAccountSchedulerHealthDecision,
  now: Date,
  maxHealthAgeMs: number,
): { readonly rank: number } | 'deny' | 'block' {
  if (
    !isRecord(decision) ||
    (decision.decision !== 'allow' && decision.decision !== 'deny' && decision.decision !== 'block')
  ) {
    return 'block';
  }
  if (decision.decision === 'deny') return 'deny';
  if (decision.decision === 'block') return 'block';
  const value = decision.value;
  if (!isRecord(value)) return 'block';
  if (
    value.status !== 'healthy' &&
    value.status !== 'degraded' &&
    value.status !== 'cooldown' &&
    value.status !== 'unhealthy'
  ) {
    return 'block';
  }
  const observedAt = date(value.observedAt);
  if (!observedAt || observedAt.getTime() > now.getTime() || now.getTime() - observedAt.getTime() > maxHealthAgeMs) {
    return 'block';
  }
  const cooldownUntil =
    value.cooldownUntil === undefined || value.cooldownUntil === null ? null : date(value.cooldownUntil);
  if (value.cooldownUntil !== undefined && value.cooldownUntil !== null && cooldownUntil === null) return 'block';
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) return 'deny';
  if (value.status === 'cooldown' || value.status === 'unhealthy') return 'deny';
  return { rank: healthStatusRank(value.status) };
}

function validRights(
  rights: unknown,
  candidate: RequestPreparationCandidateAuthority,
  protocol: GatewayProtocol,
  now: Date,
): boolean {
  if (!isRecord(rights)) return false;
  return (
    rights.status === 'active' &&
    rights.providerId === candidate.providerId &&
    rights.productId === candidate.productId &&
    rights.model === candidate.resolvedModel &&
    rights.endpoint === candidate.endpoint &&
    rights.supplyMode === candidate.supplyMode &&
    candidate.protocol === protocol &&
    revision(rights.version) &&
    withinWindow(rights.effectiveAt, now) &&
    notExpired(rights.expiresAt, now)
  );
}

function validEligibility(
  value: unknown,
  original: RequestPreparationCandidateAuthority,
  input: ProviderAccountSchedulerInput,
  now: Date,
): value is ProviderAccountSchedulerEligibilityAllowed {
  if (!isRecord(value) || value.decision !== 'allow') return false;
  if (!isRecord(value.candidate)) return false;
  const refreshed = value.candidate as unknown as RequestPreparationCandidateAuthority;
  if (!sameCandidateIdentity(original, refreshed)) {
    return false;
  }
  if (value.route !== undefined && !validRevalidatedRoute(value.route, input, refreshed)) return false;
  if (!candidateMatchesScope(input.caller, refreshed)) return false;
  if (
    value.status !== 'active' ||
    !isRecord(value.capability) ||
    value.capability.protocol !== input.protocol ||
    value.capability.supportLevel !== 'supported' ||
    value.capability.validationState !== 'verified' ||
    !validRights(value.rights, refreshed, input.protocol, now) ||
    !positiveInteger(value.weight) ||
    typeof value.priority !== 'number' ||
    !Number.isSafeInteger(value.priority) ||
    value.priority < 0 ||
    value.priority > POSITIVE_INTEGER_MAX
  ) {
    return false;
  }
  return true;
}

function compareLoad(left: EligibleCandidate, right: EligibleCandidate): number {
  const leftNumerator = BigInt(left.inFlight) * BigInt(right.concurrencyLimit);
  const rightNumerator = BigInt(right.inFlight) * BigInt(left.concurrencyLimit);
  if (leftNumerator !== rightNumerator) return leftNumerator < rightNumerator ? -1 : 1;
  return left.accountId.localeCompare(right.accountId);
}

function effectiveWeight(candidate: EligibleCandidate): bigint {
  const numerator = BigInt(candidate.weight) * BigInt(candidate.concurrencyLimit);
  const denominator = BigInt(candidate.concurrencyLimit + candidate.inFlight);
  return numerator / denominator > 0n ? numerator / denominator : 1n;
}

function deterministicDraw(seed: string, totalWeight: bigint): bigint {
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
  return BigInt(`0x${digest.slice(0, 16)}`) % totalWeight;
}

function chooseWeighted(
  candidates: readonly EligibleCandidate[],
  requestId: string,
  input: ProviderAccountSchedulerInput,
): EligibleCandidate {
  const ordered = [...candidates].sort(compareLoad);
  const totalWeight = ordered.reduce((total, candidate) => total + effectiveWeight(candidate), 0n);
  const seed = [
    requestId,
    input.caller.tenantId,
    input.caller.projectId,
    input.caller.proxyKeyId,
    input.caller.supplyProfileId,
    input.caller.supplyMode,
    input.publicModel,
    input.protocol,
  ].join('\u001f');
  let draw = deterministicDraw(seed, totalWeight);
  for (const candidate of ordered) {
    const weight = effectiveWeight(candidate);
    if (draw < weight) return candidate;
    draw -= weight;
  }
  return ordered[ordered.length - 1] as EligibleCandidate;
}

function schedulerBlock(message: string): RequestPreparationDecision<never> {
  return blockRequestPreparation('capability_unavailable', message);
}

/**
 * Selects one authorized account from a server-provided candidate set.
 * Candidate authority is refreshed before ranking; sticky state can only move
 * an already eligible candidate to the front and can never grant access.
 */
export class ProviderAccountScheduler implements ProviderAccountSchedulerPort {
  private readonly now: () => Date;
  private readonly maxHealthAgeMs: number;

  constructor(
    private readonly dependencies: ProviderAccountSchedulerDependencies,
    options: ProviderAccountSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxHealthAgeMs =
      options.maxHealthAgeMs !== undefined && Number.isSafeInteger(options.maxHealthAgeMs) && options.maxHealthAgeMs > 0
        ? Math.min(options.maxHealthAgeMs, MAX_HEALTH_AGE_MS)
        : DEFAULT_MAX_HEALTH_AGE_MS;
  }

  async select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    try {
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        return schedulerBlock('scheduler clock is unavailable');
      if (
        !isRecord(input) ||
        !isRecord(input.caller) ||
        !isRecord(input.entitlement) ||
        !nonEmpty(input.requestId) ||
        !nonEmpty(input.publicModel) ||
        !nonEmpty(input.caller.tenantId) ||
        !nonEmpty(input.caller.projectId) ||
        !nonEmpty(input.caller.proxyKeyId) ||
        !nonEmpty(input.caller.supplyProfileId) ||
        (input.caller.supplyMode !== 'byok' && input.caller.supplyMode !== 'platform')
      ) {
        return schedulerBlock('scheduler input is invalid');
      }
      if (!validAffinityContext(input.scheduling)) return schedulerBlock('scheduler affinity context is invalid');
      if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
        return rejectRequestPreparation('account_denied', 'no eligible provider account is available');
      }
      if (!this.dependencies.eligibility || !this.dependencies.health || !this.dependencies.concurrency) {
        return schedulerBlock('provider account scheduler storage ports are unavailable');
      }
      if (hasAffinityReference(input.scheduling) && !this.dependencies.affinity) {
        return schedulerBlock('provider account affinity storage is unavailable');
      }

      const attempted = new Set(input.scheduling?.attemptedAccountIds ?? []);
      const seenAccounts = new Set<string>();
      const eligible: EligibleCandidate[] = [];

      try {
        for (const candidate of input.candidates) {
          const rawCandidate: unknown = candidate;
          if (!isRecord(rawCandidate) || !nonEmpty(rawCandidate.accountId)) {
            return schedulerBlock('candidate authority is invalid');
          }
          const candidateValue = rawCandidate as unknown as RequestPreparationCandidateAuthority;
          if (seenAccounts.has(candidateValue.accountId))
            return schedulerBlock('candidate authority contains duplicate accounts');
          seenAccounts.add(candidateValue.accountId);
          if (attempted.has(candidateValue.accountId)) continue;
          if (!candidateMatchesScope(input.caller, candidateValue)) continue;

          const eligibility = await this.dependencies.eligibility.revalidate({
            caller: input.caller,
            entitlement: input.entitlement,
            candidate: candidateValue,
            publicModel: input.publicModel,
            protocol: input.protocol,
            route: input.route,
            now,
          });
          if (
            !isRecord(eligibility) ||
            (eligibility.decision !== 'allow' && eligibility.decision !== 'deny' && eligibility.decision !== 'block')
          ) {
            return schedulerBlock('provider eligibility authority returned an invalid decision');
          }
          if (eligibility.decision === 'block') return schedulerBlock(eligibility.reason);
          if (eligibility.decision === 'deny') continue;
          if (!validEligibility(eligibility, candidateValue, input, now)) {
            return schedulerBlock('provider eligibility authority returned an invalid candidate');
          }

          const health = await this.dependencies.health.get({
            caller: input.caller,
            candidate: eligibility.candidate,
            now,
          });
          const healthResult = healthValue(health, now, this.maxHealthAgeMs);
          if (healthResult === 'block') return schedulerBlock('provider account health authority is unavailable');
          if (healthResult === 'deny') continue;

          const concurrency = await this.dependencies.concurrency.get({
            caller: input.caller,
            candidate: eligibility.candidate,
            now,
          });
          if (
            !isRecord(concurrency) ||
            (concurrency.decision !== 'allow' && concurrency.decision !== 'deny' && concurrency.decision !== 'block')
          ) {
            return schedulerBlock('provider account concurrency authority returned an invalid decision');
          }
          if (concurrency.decision === 'block') return schedulerBlock(concurrency.reason);
          if (concurrency.decision === 'deny') continue;
          if (
            !isRecord(concurrency.value) ||
            !nonNegativeInteger(concurrency.value.inFlight) ||
            !positiveInteger(concurrency.value.limit) ||
            concurrency.value.inFlight >= concurrency.value.limit
          ) {
            if (isRecord(concurrency.value) && concurrency.value.inFlight >= concurrency.value.limit) continue;
            return schedulerBlock('provider account concurrency authority is invalid');
          }

          eligible.push({
            candidate: eligibility.candidate,
            priority: eligibility.priority,
            weight: eligibility.weight,
            inFlight: concurrency.value.inFlight,
            concurrencyLimit: concurrency.value.limit,
            healthRank: healthResult.rank,
            accountId: eligibility.candidate.accountId,
            route: eligibility.route,
          });
        }

        if (eligible.length === 0)
          return rejectRequestPreparation('account_denied', 'no eligible provider account is available');

        let affinityAccountId: string | null = null;
        if (hasAffinityReference(input.scheduling)) {
          const scope = affinityScopeFromSelection(input, eligible);
          if (!scope) return schedulerBlock('provider account affinity route scope is unavailable or stale');
          const affinity = await this.dependencies.affinity?.resolve({
            caller: input.caller,
            entitlement: input.entitlement,
            publicModel: input.publicModel,
            protocol: input.protocol,
            context: input.scheduling as RequestPreparationSchedulingContext,
            scope,
            eligibleAccountIds: eligible.map(({ accountId }) => accountId),
          });
          if (!isRecord(affinity) || (affinity.decision !== 'allow' && affinity.decision !== 'block')) {
            return schedulerBlock('provider account affinity authority returned an invalid decision');
          }
          if (affinity.decision === 'block') return schedulerBlock(affinity.reason);
          if (affinity.accountId !== null && !nonEmpty(affinity.accountId)) {
            return schedulerBlock('provider account affinity returned an invalid account');
          }
          affinityAccountId = affinity.accountId;
        }

        const highestPriority = Math.max(...eligible.map((candidate) => candidate.priority));
        const bestPriority = eligible.filter((candidate) => candidate.priority === highestPriority);
        const bestHealthRank = Math.min(...bestPriority.map((candidate) => candidate.healthRank));
        const ranked = bestPriority.filter((candidate) => candidate.healthRank === bestHealthRank);
        const preferred =
          affinityAccountId === null ? undefined : eligible.find(({ accountId }) => accountId === affinityAccountId);
        if (affinityAccountId !== null && !preferred) {
          return schedulerBlock('persisted provider account affinity target is no longer eligible');
        }
        if (preferred) return allowRequestPreparation(preferred.candidate);
        const selected = chooseWeighted(ranked, input.requestId, input);
        return allowRequestPreparation(selected.candidate);
      } catch {
        return schedulerBlock('provider account scheduler failed closed');
      }
    } catch {
      return schedulerBlock('provider account scheduler failed closed');
    }
  }

  async bindAffinity(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision> {
    if (!hasAffinityReference(input?.context)) return { decision: 'allow' };
    try {
      if (!validAffinityContext(input.context)) {
        return { decision: 'block', reason: 'scheduler affinity context is invalid' };
      }
      const scope = affinityScopeFromBinding(input);
      if (!scope) return { decision: 'block', reason: 'provider account affinity route scope is invalid' };
      if (!this.dependencies.affinity?.bind) {
        return { decision: 'block', reason: 'provider account affinity storage is unavailable' };
      }
      const decision = await this.dependencies.affinity.bind({
        context: input.context,
        scope,
        accountId: input.candidate.accountId,
      });
      if (!isRecord(decision) || (decision.decision !== 'allow' && decision.decision !== 'block')) {
        return { decision: 'block', reason: 'provider account affinity authority returned an invalid decision' };
      }
      return decision.decision === 'allow' ? { decision: 'allow' } : { decision: 'block', reason: decision.reason };
    } catch {
      return { decision: 'block', reason: 'provider account affinity binding failed closed' };
    }
  }
}
