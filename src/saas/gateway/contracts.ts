import type { Protocol } from '../../config/types.js';
import { matchGlob } from '../../protocol/glob.js';
import type { NormalizedUsage } from '../../telemetry/usage.js';

/** The hosted gateway's supply modes. Local/self-hosted proxy paths do not use this contract. */
export type SupplyMode = 'byok' | 'platform';

/**
 * Database-owned route target modes.  These are deliberately narrower than
 * the runtime's upstream configuration: the route authority records only the
 * non-secret ownership shape that a later supply-authority check must bind.
 */
export type SaasRouteTargetMode = 'tenant_account' | 'platform_pool';

/** Keep the SaaS gateway aligned with the protocols already understood by the proxy. */
export type GatewayProtocol = Protocol;

/** Versions are server-owned, safe-integer revisions of the authorization snapshots. */
export type SaasVersion = number;

/** The provenance of the public-model-to-provider-model mapping decision. */
export type ModelMappingSource = 'none' | 'alias' | 'wildcard';

/** One server-owned model mapping rule, ordered as configured for wildcard fallback. */
export interface ModelMappingRule {
  /** Exact alias text or the existing glob pattern syntax. */
  readonly pattern: string;
  readonly mappedModel: string;
  readonly mappingSource: Exclude<ModelMappingSource, 'none'>;
  readonly mappingVersion: SaasVersion;
}

/** The mapping result before a provider-specific resolved model is selected. */
export interface ModelMappingResolution {
  readonly mappedModel: string;
  readonly mappingSource: ModelMappingSource;
  readonly mappingVersion: SaasVersion | null;
}

/**
 * Immutable, non-secret model provenance carried alongside provider authority.
 * `resolvedModel` is a transport name; provider/product/account and policy
 * snapshots remain the authority for provider access and commercial identity.
 */
export interface ModelResolutionProvenance {
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  readonly mappingSource: ModelMappingSource;
  readonly mappingVersion: SaasVersion | null;
}

/**
 * Attach the provider-selected transport model to a server-owned mapping
 * decision without making that transport name an authorization or billing
 * authority.
 */
export function createModelResolutionProvenance(
  requestedModel: string,
  resolvedModel: string,
  rules: readonly ModelMappingRule[] = [],
): ModelResolutionProvenance {
  const mapping = resolveModelMapping(requestedModel, rules);
  const requested = modelText(requestedModel, 'requestedModel');
  const resolved = modelText(resolvedModel, 'resolvedModel');
  if (mapping.mappingSource === 'none' && resolved !== requested) {
    throw new Error('non-identity model resolution requires mapping source and version');
  }
  return {
    requestedModel: requested,
    mappedModel: mapping.mappedModel,
    resolvedModel: resolved,
    mappingSource: mapping.mappingSource,
    mappingVersion: mapping.mappingVersion,
  };
}

/**
 * Preserve the router's established priority: exact alias, then the first
 * matching wildcard in configured order, then passthrough when no rule matches.
 */
export function resolveModelMapping(
  requestedModel: string,
  rules: readonly ModelMappingRule[],
): ModelMappingResolution {
  const model = modelText(requestedModel, 'requestedModel');
  if (!Array.isArray(rules)) throw new Error('model mapping rules must be an array');
  const normalizedRules = rules.map((rule, index) => normalizeModelMappingRule(rule, index));

  const exact = normalizedRules.find((rule) => rule.mappingSource === 'alias' && rule.pattern === model);
  if (exact) {
    return {
      mappedModel: exact.mappedModel,
      mappingSource: 'alias',
      mappingVersion: exact.mappingVersion,
    };
  }

  for (const rule of normalizedRules) {
    if (rule.mappingSource === 'wildcard' && matchGlob(rule.pattern, model)) {
      return {
        mappedModel: rule.mappedModel,
        mappingSource: 'wildcard',
        mappingVersion: rule.mappingVersion,
      };
    }
  }

  return { mappedModel: model, mappingSource: 'none', mappingVersion: null };
}

function modelText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function normalizeModelMappingRule(value: unknown, index: number): ModelMappingRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`model mapping rule ${index} is invalid`);
  }
  const rule = value as Record<string, unknown>;
  const pattern = modelText(rule.pattern, `model mapping rule ${index}.pattern`);
  const mappedModel = modelText(rule.mappedModel, `model mapping rule ${index}.mappedModel`);
  const mappingSource = rule.mappingSource;
  if (mappingSource !== 'alias' && mappingSource !== 'wildcard') {
    throw new Error(`model mapping rule ${index}.mappingSource is invalid`);
  }
  if (mappingSource === 'alias' && /[*?]/.test(pattern)) {
    throw new Error(`model mapping rule ${index} alias pattern must be exact`);
  }
  if (mappingSource === 'wildcard' && !/[*?]/.test(pattern)) {
    throw new Error(`model mapping rule ${index} wildcard pattern must contain a glob`);
  }
  const mappingVersion = rule.mappingVersion;
  if (typeof mappingVersion !== 'number' || !Number.isSafeInteger(mappingVersion) || mappingVersion < 1) {
    throw new Error(`model mapping rule ${index}.mappingVersion is invalid`);
  }
  return { pattern, mappedModel, mappingSource, mappingVersion };
}

/** A stable opaque request identifier allocated by the hosted gateway. */
export type SaasRequestId = string;

/** A stable opaque identifier allocated for one upstream dispatch attempt. */
export type SaasAttemptId = string;

/** Tenant/project/key/supply boundary that a candidate is required to carry. */
export interface SaasProxyPermissionBoundary {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: SupplyMode;
}

/** Server-owned revisions captured when an authorization decision is made. */
export interface SaasProxyAuthorizationVersions {
  readonly authzVersion: SaasVersion;
  readonly entitlementVersion: SaasVersion;
  readonly configVersion: SaasVersion;
}

/**
 * Server-built SaaS authorization context.
 *
 * Request bodies and headers may select an API surface, but never provide or
 * overwrite this context. It intentionally contains neither the raw proxy key
 * nor an upstream credential/secret.
 */
export interface SaasProxyAuthorizationContext extends SaasProxyPermissionBoundary, SaasProxyAuthorizationVersions {
  readonly principalId: string;
}

/** Common non-secret dispatch authority facts carried by every candidate. */
interface AuthorizedUpstreamCandidateCommon extends SaasProxyPermissionBoundary {
  readonly upstreamId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: SaasVersion;
  readonly credentialAuthzVersion: SaasVersion;
  readonly accountAuthzVersion: SaasVersion;
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: SaasVersion;
  readonly resolvedModel: string;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly supplierCostVersion: string | null;
}

/** Tenant-owned BYOK authority is bound through one profile-account mapping. */
export interface AuthorizedByokUpstreamCandidate extends AuthorizedUpstreamCandidateCommon {
  readonly supplyMode: 'byok';
  readonly accountOwnerKind: 'tenant';
  readonly profileAccountAuthzVersion: SaasVersion;
  readonly poolId?: never;
  readonly poolAuthzVersion?: never;
  readonly poolMemberAccountAuthzVersion?: never;
  readonly poolMemberAuthzVersion?: never;
  readonly poolGrantAuthzVersion?: never;
  readonly poolGrantProfileAuthzVersion?: never;
  readonly poolGrantPoolAuthzVersion?: never;
}

/** Platform authority is bound through the selected pool member and grant. */
export interface AuthorizedPlatformUpstreamCandidate extends AuthorizedUpstreamCandidateCommon {
  readonly supplyMode: 'platform';
  readonly accountOwnerKind: 'platform';
  readonly poolId: string;
  readonly poolAuthzVersion: SaasVersion;
  readonly poolMemberAccountAuthzVersion: SaasVersion;
  /** The member lifecycle epoch belongs to this candidate, not the pool. */
  readonly poolMemberAuthzVersion?: SaasVersion;
  readonly poolGrantAuthzVersion: SaasVersion;
  readonly poolGrantProfileAuthzVersion: SaasVersion;
  readonly poolGrantPoolAuthzVersion: SaasVersion;
  readonly profileAccountAuthzVersion?: never;
}

/**
 * A candidate that has already passed tenant/project/profile/mode filtering.
 * IDs and revisions are stable non-secret references only; resolving a
 * credential secret happens outside this contract and is never represented.
 */
export type AuthorizedUpstreamCandidate = AuthorizedByokUpstreamCandidate | AuthorizedPlatformUpstreamCandidate;

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type ModelAuthorizationDenyReason = 'no_authorized_candidates' | 'candidate_scope_mismatch';

export interface ModelAuthorizationAllowed {
  readonly decision: 'allow';
  readonly model: string;
  readonly protocol: GatewayProtocol;
  readonly authorization: SaasProxyAuthorizationContext;
  readonly candidates: NonEmptyReadonlyArray<AuthorizedUpstreamCandidate>;
}

export interface ModelAuthorizationDenied {
  readonly decision: 'deny';
  readonly model: string;
  readonly protocol: GatewayProtocol;
  readonly authorization: SaasProxyAuthorizationContext;
  /** Deny carries an explicit empty set; empty never means unrestricted. */
  readonly candidates: readonly [];
  readonly reason: ModelAuthorizationDenyReason;
}

export type ModelAuthorizationResult = ModelAuthorizationAllowed | ModelAuthorizationDenied;

/** Existing normalized usage, exposed as an immutable metering input. */
export type GatewayUsage = Readonly<NormalizedUsage>;

/** An explicit usage budget; no token or money calculation is performed here. */
export interface TokenUsageBudget {
  readonly unit: 'tokens';
  readonly amount: number;
  readonly basis: 'reserved' | 'estimated' | 'explicit';
}

export interface DispatchBudget {
  readonly deadlineAtMs: number;
  readonly remainingAttempts: number;
  readonly usage: TokenUsageBudget | null;
}

export interface AttemptBusinessKey {
  readonly namespace: 'saas-proxy-attempt';
  readonly requestId: SaasRequestId;
  readonly attemptId: SaasAttemptId;
}

/** Persistence intent for a permit; state is prepared, not sent. */
export interface DispatchPersistenceIntent {
  readonly state: 'prepared';
  readonly businessKey: AttemptBusinessKey;
  readonly attemptOrdinal: number;
}

/**
 * Mode-specific settlement semantics. BYOK records usage only; platform
 * finalization is the future hook for a single ledger/outbox transaction and
 * does not claim that a wallet debit has already happened.
 */
export interface ByokSettlementPlan {
  readonly supplyMode: 'byok';
  readonly wallet: 'not_applicable';
}

export interface PlatformSettlementPlan {
  readonly supplyMode: 'platform';
  readonly wallet: 'finalize_transaction';
}

export type DispatchSettlementPlan = ByokSettlementPlan | PlatformSettlementPlan;

interface DispatchPermitCommon {
  readonly state: 'prepared';
  readonly requestId: SaasRequestId;
  readonly attemptId: SaasAttemptId;
  readonly authorization: ModelAuthorizationAllowed;
  readonly candidate: AuthorizedUpstreamCandidate;
  /** Stable credential reference only; never a resolved secret. */
  readonly credentialRef: string;
  readonly budget: DispatchBudget;
  readonly persistence: DispatchPersistenceIntent;
}

/**
 * A permit authorizes preparation of one attempt and persistence of its intent.
 * It does not assert that an HTTP request was sent.
 */
export type DispatchPermit =
  | (DispatchPermitCommon & {
      readonly supplyMode: 'byok';
      readonly settlement: ByokSettlementPlan;
      readonly candidate: AuthorizedUpstreamCandidate & { readonly supplyMode: 'byok' };
    })
  | (DispatchPermitCommon & {
      readonly supplyMode: 'platform';
      readonly settlement: PlatformSettlementPlan;
      readonly candidate: AuthorizedUpstreamCandidate & { readonly supplyMode: 'platform' };
    });

export type PreparedDispatch = DispatchPermit;

export type AttemptDispatchState = 'not_sent' | 'dispatching' | 'sent' | 'unknown';

export type AttemptResultState = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

/** Opaque evidence pointers only; raw provider payloads, keys, and credentials are excluded. */
export interface GatewayEvidenceReference {
  readonly reference: string;
  readonly digest: string;
}

/** Evidence for a normalized usage snapshot attached to one attempt. */
export interface AttemptUsageEvidence extends GatewayEvidenceReference {
  readonly kind: 'normalized_usage';
  readonly source: GatewayUsage['source'];
  readonly semanticsVersion: string;
}

export interface AttemptObservationCommon {
  readonly kind: 'observe_attempt';
  readonly businessKey: AttemptBusinessKey;
  readonly dispatchState: AttemptDispatchState;
  readonly resultState: AttemptResultState;
  /** Monotonic fact: once true for this attempt, later observations must keep it true. */
  readonly responseStarted: boolean;
  readonly usage: GatewayUsage | null;
  readonly usageEvidence: AttemptUsageEvidence | null;
}

export interface ByokAttemptObservation extends AttemptObservationCommon {
  readonly supplyMode: 'byok';
  readonly wallet: 'not_applicable';
}

export interface PlatformAttemptObservation extends AttemptObservationCommon {
  readonly supplyMode: 'platform';
  readonly wallet?: never;
}

export type AttemptObservation = ByokAttemptObservation | PlatformAttemptObservation;

export type AttemptObservationInput = Omit<AttemptObservationCommon, 'kind'> &
  ({ readonly supplyMode: 'byok' } | { readonly supplyMode: 'platform' });

export interface ByokAttemptFinalization {
  readonly kind: 'finalize_attempt';
  readonly businessKey: AttemptBusinessKey;
  readonly supplyMode: 'byok';
  readonly wallet: 'not_applicable';
  readonly observation: ByokAttemptObservation;
}

export interface PlatformAttemptFinalization {
  readonly kind: 'finalize_attempt';
  readonly businessKey: AttemptBusinessKey;
  readonly supplyMode: 'platform';
  readonly wallet?: never;
  readonly observation: PlatformAttemptObservation;
}

/** Attempt finalization records execution facts only; request-level billing owns financial resolution. */
export type AttemptFinalization = ByokAttemptFinalization | PlatformAttemptFinalization;

export type MoneyAmount = Readonly<{
  readonly currency: string;
  /** Exact integer minor units; zero is an amount, never a missing-value sentinel. */
  readonly minorUnits: bigint;
}>;

export interface RequestFinancialBusinessKey {
  readonly namespace: 'saas-request-financial-resolution';
  readonly requestId: SaasRequestId;
  readonly reservationId: string;
  readonly settlementId: string;
}

export interface BillableUsageEvidence {
  readonly digest: string;
  readonly evidence: NonEmptyReadonlyArray<GatewayEvidenceReference>;
}

export type ConfirmedNonExecutionBasis =
  | 'reservation_never_dispatched'
  | 'all_attempts_not_sent'
  | 'provider_confirmed_not_executed';

export interface ConfirmedNonExecutionEvidence extends GatewayEvidenceReference {
  readonly basis: ConfirmedNonExecutionBasis;
}

export type RetainHoldReason = 'dispatch_uncertain' | 'usage_uncertain' | 'usage_overrun' | 'settlement_uncertain';

export interface RequestSettleResolution {
  readonly kind: 'settle';
  readonly businessKey: RequestFinancialBusinessKey;
  readonly supplyMode: 'platform';
  /** Exact, non-null customer settlement amount. Explicit zero remains representable. */
  readonly amount: MoneyAmount;
  readonly priceSnapshotRef: string;
  readonly billableUsage: BillableUsageEvidence;
}

export interface RequestReleaseResolution {
  readonly kind: 'release';
  readonly businessKey: RequestFinancialBusinessKey;
  readonly supplyMode: 'platform';
  readonly basis: ConfirmedNonExecutionBasis;
  readonly reason: string;
  readonly evidence: NonEmptyReadonlyArray<ConfirmedNonExecutionEvidence>;
}

export interface RequestRetainHoldResolution {
  readonly kind: 'retain_hold';
  readonly businessKey: RequestFinancialBusinessKey;
  readonly supplyMode: 'platform';
  readonly reason: RetainHoldReason;
  readonly evidence: NonEmptyReadonlyArray<GatewayEvidenceReference>;
  readonly nextReviewAt: string;
}

/** Request-level decisions are separate from attempt execution observations. */
export type RequestFinancialResolution =
  | RequestSettleResolution
  | RequestReleaseResolution
  | RequestRetainHoldResolution;

/** Workflow status only; reconciliation-pending is deliberately not a resolution variant. */
export interface RequestFinancialReconciliationPending {
  readonly kind: 'reconciliation_pending';
  readonly terminal: false;
  readonly businessKey: RequestFinancialBusinessKey;
  readonly supplyMode: 'platform';
  readonly reason: RetainHoldReason;
  readonly nextReviewAt: string;
}

export type RequestFinancialResolutionInput =
  | Omit<RequestSettleResolution, never>
  | Omit<RequestReleaseResolution, never>
  | Omit<RequestRetainHoldResolution, never>;

export type RequestFinancialReconciliationPendingInput = Omit<RequestFinancialReconciliationPending, 'terminal'>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

const attemptDispatchStates: readonly AttemptDispatchState[] = ['not_sent', 'dispatching', 'sent', 'unknown'];
const attemptResultStates: readonly AttemptResultState[] = ['pending', 'succeeded', 'failed', 'cancelled', 'unknown'];
const usageStatuses: readonly GatewayUsage['status'][] = ['reported', 'partial', 'missing', 'estimated'];
const usageSources: readonly GatewayUsage['source'][] = ['upstream', 'local-estimate', 'legacy'];
const usageTokenFields = [
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
] as const;

export function createAttemptBusinessKey(input: AttemptBusinessKey): AttemptBusinessKey {
  const value = record(input, 'Attempt business key');
  if (value.namespace !== 'saas-proxy-attempt') throw new Error('Invalid attempt business-key namespace');
  return {
    namespace: 'saas-proxy-attempt',
    requestId: nonEmptyString(value.requestId, 'requestId'),
    attemptId: nonEmptyString(value.attemptId, 'attemptId'),
  };
}

function createEvidenceReference(input: GatewayEvidenceReference, label: string): GatewayEvidenceReference {
  const value = record(input, label);
  return {
    reference: nonEmptyString(value.reference, `${label}.reference`),
    digest: nonEmptyString(value.digest, `${label}.digest`),
  };
}

function createAttemptUsageEvidence(input: AttemptUsageEvidence): AttemptUsageEvidence {
  const value = record(input, 'Attempt usage evidence');
  const reference = createEvidenceReference(value as unknown as GatewayEvidenceReference, 'Attempt usage evidence');
  if (value.kind !== 'normalized_usage' || !isOneOf(value.source, usageSources)) {
    throw new Error('Attempt usage evidence must identify normalized usage and its source');
  }
  return {
    ...reference,
    kind: 'normalized_usage',
    source: value.source,
    semanticsVersion: nonEmptyString(value.semanticsVersion, 'usageEvidence.semanticsVersion'),
  };
}

function createNormalizedUsage(input: GatewayUsage): GatewayUsage {
  const value = record(input, 'Normalized usage');
  for (const field of usageTokenFields) {
    const token = value[field];
    if (token !== null && (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0)) {
      throw new Error(`Normalized usage ${field} must be a non-negative safe integer or null`);
    }
  }
  if (!isOneOf(value.status, usageStatuses) || !isOneOf(value.source, usageSources)) {
    throw new Error('Normalized usage has an unsupported status or source');
  }
  return {
    inputTotal: value.inputTotal as number | null,
    inputUncached: value.inputUncached as number | null,
    cacheRead: value.cacheRead as number | null,
    cacheWrite: value.cacheWrite as number | null,
    cacheWrite5m: value.cacheWrite5m as number | null,
    cacheWrite1h: value.cacheWrite1h as number | null,
    outputTotal: value.outputTotal as number | null,
    reasoningOutput: value.reasoningOutput as number | null,
    status: value.status,
    source: value.source,
    semanticsVersion: nonEmptyString(value.semanticsVersion, 'usage.semanticsVersion'),
  };
}

function createAttemptObservationCore(input: AttemptObservationInput): AttemptObservationCommon & {
  readonly supplyMode: SupplyMode;
} {
  const value = record(input, 'Attempt observation');
  if (!isOneOf(value.dispatchState, attemptDispatchStates)) throw new Error('Invalid attempt dispatch state');
  if (!isOneOf(value.resultState, attemptResultStates)) throw new Error('Invalid attempt result state');
  if (value.supplyMode !== 'byok' && value.supplyMode !== 'platform') throw new Error('Invalid attempt supply mode');
  if (typeof value.responseStarted !== 'boolean') throw new Error('responseStarted must be boolean');

  const dispatchState = value.dispatchState;
  const resultState = value.resultState;
  const responseStarted = value.responseStarted;
  const usage = value.usage === null ? null : createNormalizedUsage(value.usage as GatewayUsage);
  const usageEvidence =
    value.usageEvidence === null ? null : createAttemptUsageEvidence(value.usageEvidence as AttemptUsageEvidence);

  if (responseStarted && dispatchState !== 'sent') {
    throw new Error('responseStarted requires dispatchState sent');
  }
  if ((usage === null) !== (usageEvidence === null)) {
    throw new Error('Normalized usage and its evidence must be provided together');
  }
  if (usage !== null && !responseStarted) throw new Error('Normalized usage requires responseStarted');
  if (
    usage !== null &&
    usageEvidence !== null &&
    (usage.source !== usageEvidence.source || usage.semanticsVersion !== usageEvidence.semanticsVersion)
  ) {
    throw new Error('Usage evidence must match normalized usage source and semantics version');
  }
  if (resultState === 'succeeded' && (dispatchState !== 'sent' || !responseStarted)) {
    throw new Error('A succeeded attempt requires a sent dispatch and a started response');
  }
  if (dispatchState === 'not_sent' && (resultState === 'succeeded' || resultState === 'unknown')) {
    throw new Error('A not_sent attempt cannot be succeeded or execution-unknown');
  }
  if (dispatchState === 'dispatching' && responseStarted) {
    throw new Error('A dispatching attempt cannot already have a started response');
  }
  if (dispatchState === 'unknown' && resultState !== 'pending' && resultState !== 'unknown') {
    throw new Error('An unknown dispatch cannot claim a definitive attempt result');
  }

  return {
    kind: 'observe_attempt',
    businessKey: createAttemptBusinessKey(value.businessKey as AttemptBusinessKey),
    supplyMode: value.supplyMode,
    dispatchState,
    resultState,
    responseStarted,
    usage,
    usageEvidence,
  };
}

export function createAttemptObservation(input: AttemptObservationInput): AttemptObservation {
  const observation = createAttemptObservationCore(input);
  if (observation.supplyMode === 'byok') {
    return { ...observation, supplyMode: 'byok', wallet: 'not_applicable' };
  }
  return { ...observation, supplyMode: 'platform' };
}

function sameAttemptBusinessKey(left: AttemptBusinessKey, right: AttemptBusinessKey): boolean {
  return left.namespace === right.namespace && left.requestId === right.requestId && left.attemptId === right.attemptId;
}

/** Finalize execution facts for one attempt; this function never makes a financial decision. */
export function finalizeAttemptObservation(
  previous: AttemptObservation | null,
  input: AttemptObservationInput,
): AttemptFinalization {
  const observation = createAttemptObservation(input);
  if (previous !== null) {
    const checkedPrevious = createAttemptObservation(previous);
    if (!sameAttemptBusinessKey(checkedPrevious.businessKey, observation.businessKey)) {
      throw new Error('Attempt observations must keep the same business identity');
    }
    if (checkedPrevious.supplyMode !== observation.supplyMode) {
      throw new Error('Attempt observations must keep the same supply mode');
    }
    if (checkedPrevious.responseStarted && !observation.responseStarted) {
      throw new Error('responseStarted is monotonic for an attempt');
    }
  }

  if (observation.supplyMode === 'byok') {
    return {
      kind: 'finalize_attempt',
      businessKey: observation.businessKey,
      supplyMode: 'byok',
      wallet: 'not_applicable',
      observation,
    };
  }
  return {
    kind: 'finalize_attempt',
    businessKey: observation.businessKey,
    supplyMode: 'platform',
    observation,
  };
}

const confirmedNonExecutionBases: readonly ConfirmedNonExecutionBasis[] = [
  'reservation_never_dispatched',
  'all_attempts_not_sent',
  'provider_confirmed_not_executed',
];
const retainHoldReasons: readonly RetainHoldReason[] = [
  'dispatch_uncertain',
  'usage_uncertain',
  'usage_overrun',
  'settlement_uncertain',
];

export function createRequestFinancialBusinessKey(input: RequestFinancialBusinessKey): RequestFinancialBusinessKey {
  const value = record(input, 'Request financial business key');
  if (value.namespace !== 'saas-request-financial-resolution') {
    throw new Error('Invalid request financial business-key namespace');
  }
  return {
    namespace: 'saas-request-financial-resolution',
    requestId: nonEmptyString(value.requestId, 'requestId'),
    reservationId: nonEmptyString(value.reservationId, 'reservationId'),
    settlementId: nonEmptyString(value.settlementId, 'settlementId'),
  };
}

function createEvidenceReferences(input: unknown, label: string): NonEmptyReadonlyArray<GatewayEvidenceReference> {
  if (!Array.isArray(input) || input.length === 0) throw new Error(`${label} must not be empty`);
  const references = input.map((value, index) =>
    createEvidenceReference(value as GatewayEvidenceReference, `${label}[${index}]`),
  );
  return references as unknown as NonEmptyReadonlyArray<GatewayEvidenceReference>;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be a UTC ISO timestamp with milliseconds`);
  }
  return timestamp;
}

/** Build a terminal platform request decision with an exact amount or explicit evidence-backed release. */
export function createRequestFinancialResolution(input: RequestFinancialResolutionInput): RequestFinancialResolution {
  const value = record(input, 'Request financial resolution');
  const businessKey = createRequestFinancialBusinessKey(value.businessKey as RequestFinancialBusinessKey);
  if (value.supplyMode !== 'platform')
    throw new Error('Request wallet resolution is only applicable to platform supply');

  if (value.kind === 'settle') {
    const amount = record(value.amount, 'Settlement amount');
    if (typeof amount.minorUnits !== 'bigint' || amount.minorUnits < 0n) {
      throw new Error('Settlement amount must be exact, non-negative integer minor units');
    }
    const normalizedAmount: MoneyAmount = {
      currency: nonEmptyString(amount.currency, 'amount.currency'),
      minorUnits: amount.minorUnits,
    };
    if (!/^[A-Z]{3}$/.test(normalizedAmount.currency))
      throw new Error('Settlement currency must be an uppercase 3-letter code');

    const billableUsage = record(value.billableUsage, 'Billable usage evidence');
    return {
      kind: 'settle',
      businessKey,
      supplyMode: 'platform',
      amount: normalizedAmount,
      priceSnapshotRef: nonEmptyString(value.priceSnapshotRef, 'priceSnapshotRef'),
      billableUsage: {
        digest: nonEmptyString(billableUsage.digest, 'billableUsage.digest'),
        evidence: createEvidenceReferences(billableUsage.evidence, 'billableUsage.evidence'),
      },
    };
  }

  if (value.kind === 'release') {
    if (!isOneOf(value.basis, confirmedNonExecutionBases)) {
      throw new Error('Release requires an explicit confirmed non-execution basis');
    }
    const reason = nonEmptyString(value.reason, 'release.reason');
    const rawEvidence = value.evidence;
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) throw new Error('Release evidence must not be empty');
    const evidence = rawEvidence.map((entry, index) => {
      const item = record(entry, `release.evidence[${index}]`);
      if (item.basis !== value.basis)
        throw new Error('Release evidence basis must match the confirmed non-execution basis');
      return {
        ...createEvidenceReference(item as unknown as GatewayEvidenceReference, `release.evidence[${index}]`),
        basis: value.basis,
      };
    }) as unknown as NonEmptyReadonlyArray<ConfirmedNonExecutionEvidence>;
    return { kind: 'release', businessKey, supplyMode: 'platform', basis: value.basis, reason, evidence };
  }

  if (value.kind === 'retain_hold') {
    if (!isOneOf(value.reason, retainHoldReasons))
      throw new Error('Retain-hold requires an uncertainty or overrun reason');
    return {
      kind: 'retain_hold',
      businessKey,
      supplyMode: 'platform',
      reason: value.reason,
      evidence: createEvidenceReferences(value.evidence, 'retain_hold.evidence'),
      nextReviewAt: isoTimestamp(value.nextReviewAt, 'nextReviewAt'),
    };
  }

  throw new Error('Unsupported request financial resolution kind');
}

/** Reconciliation-pending is a workflow checkpoint, separate from terminal resolution decisions. */
export function createRequestFinancialReconciliationPending(
  input: RequestFinancialReconciliationPendingInput,
): RequestFinancialReconciliationPending {
  const value = record(input, 'Request financial reconciliation status');
  if (value.kind !== 'reconciliation_pending' || value.supplyMode !== 'platform') {
    throw new Error('Invalid request financial reconciliation status');
  }
  if (!isOneOf(value.reason, retainHoldReasons))
    throw new Error('Reconciliation-pending requires an uncertainty or overrun reason');
  return {
    kind: 'reconciliation_pending',
    terminal: false,
    businessKey: createRequestFinancialBusinessKey(value.businessKey as RequestFinancialBusinessKey),
    supplyMode: 'platform',
    reason: value.reason,
    nextReviewAt: isoTimestamp(value.nextReviewAt, 'nextReviewAt'),
  };
}

/** Return a non-empty tuple so an allowed result cannot carry an empty candidate set. */
export function requireNonEmptyCandidates<T>(candidates: readonly T[]): NonEmptyReadonlyArray<T> {
  if (candidates.length === 0) throw new Error('Authorized candidate set must not be empty');
  return candidates as NonEmptyReadonlyArray<T>;
}

/** Candidate scope must remain fixed to the server-built authorization boundary. */
export function candidateMatchesScope(
  boundary: SaasProxyPermissionBoundary,
  candidate: AuthorizedUpstreamCandidate,
): boolean {
  return (
    candidate.tenantId === boundary.tenantId &&
    candidate.projectId === boundary.projectId &&
    candidate.proxyKeyId === boundary.proxyKeyId &&
    candidate.supplyProfileId === boundary.supplyProfileId &&
    candidate.supplyMode === boundary.supplyMode
  );
}

/**
 * Build the small model decision used by hosted adapters. This only validates
 * candidate presence/scope; entitlement, routing, and credential services own
 * the preceding business decisions.
 */
export function authorizeModelCandidates(
  authorization: SaasProxyAuthorizationContext,
  model: string,
  protocol: GatewayProtocol,
  candidates: readonly AuthorizedUpstreamCandidate[],
): ModelAuthorizationResult {
  if (candidates.length === 0) {
    return {
      decision: 'deny',
      model,
      protocol,
      authorization,
      candidates: [],
      reason: 'no_authorized_candidates',
    };
  }

  if (candidates.some((candidate) => !candidateMatchesScope(authorization, candidate))) {
    return {
      decision: 'deny',
      model,
      protocol,
      authorization,
      candidates: [],
      reason: 'candidate_scope_mismatch',
    };
  }

  return {
    decision: 'allow',
    model,
    protocol,
    authorization,
    candidates: requireNonEmptyCandidates(candidates),
  };
}
