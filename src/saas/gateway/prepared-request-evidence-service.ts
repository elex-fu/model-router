import { createHash, createPublicKey, type KeyObject, randomUUID, verify as verifySignature } from 'node:crypto';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type { ModelResolutionProvenance } from './contracts.js';

export const PREPARED_REQUEST_EVIDENCE_SCHEMA_VERSION = 1;
export const PREPARED_REQUEST_EVIDENCE_DOMAIN = 'model-router/saas/prepared-request-evidence/v1';

export type PreparedEvidenceInteger = bigint | number | string;
export type PreparedEvidenceSupplyMode = 'byok' | 'platform';
export type PreparedEvidencePrincipalKind = 'member' | 'project_service';
export type PreparedEvidenceOwnerKind = 'tenant' | 'platform';
export type PreparedEvidenceProtocol = 'anthropic' | 'openai' | 'gemini' | 'responses';
export type PreparedEvidenceTargetMode = 'tenant_account' | 'platform_pool';

export interface PreparedRequestUsageEnvelope {
  readonly inputTotalUpperBound: PreparedEvidenceInteger;
  readonly inputUncachedUpperBound: PreparedEvidenceInteger;
  readonly cacheReadUpperBound: PreparedEvidenceInteger;
  readonly cacheWriteUpperBound: PreparedEvidenceInteger;
  readonly cacheWrite5mUpperBound: PreparedEvidenceInteger;
  readonly cacheWrite1hUpperBound: PreparedEvidenceInteger;
  readonly outputTotalUpperBound: PreparedEvidenceInteger;
  readonly reasoningOutputUpperBound: PreparedEvidenceInteger;
  readonly feasibleInputBuckets: readonly string[];
}

export interface PreparedRequestEvidenceAudit {
  readonly actorUserId: string | null;
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface PreparedRequestEvidenceInput {
  readonly evidenceId?: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly proxyKeyId: string;
  readonly entitlementId: string;
  readonly entitlementVersion: PreparedEvidenceInteger;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: PreparedEvidenceInteger;
  readonly modelScopeVersion: PreparedEvidenceInteger;
  readonly supplyMode: PreparedEvidenceSupplyMode;
  readonly principalKind: PreparedEvidencePrincipalKind;
  readonly principalId: string;
  readonly authzVersion: PreparedEvidenceInteger;
  readonly configVersion: PreparedEvidenceInteger;
  readonly projectPolicyVersion: PreparedEvidenceInteger;
  readonly publicModel: string;
  /** Migration 029 snapshot; identity inputs may omit this for legacy compatibility. */
  readonly modelResolution?: ModelResolutionProvenance;
  readonly protocol: PreparedEvidenceProtocol;
  /** Migration 029 persists the provider route facts; client protocol is `protocol`. */
  readonly clientProtocol?: PreparedEvidenceProtocol;
  readonly providerProtocol?: PreparedEvidenceProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  readonly endpoint: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: PreparedEvidenceInteger;
  readonly routePublicModelId: string;
  readonly routePublicModelVersion: PreparedEvidenceInteger;
  readonly routeProtocol: PreparedEvidenceProtocol;
  readonly routeTargetMode: PreparedEvidenceTargetMode;
  readonly routeUpstreamId: string;
  readonly upstreamId: string;
  readonly accountOwnerKind: PreparedEvidenceOwnerKind;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: PreparedEvidenceInteger;
  readonly credentialId: string;
  readonly credentialVersion: PreparedEvidenceInteger;
  readonly credentialAuthzVersion: PreparedEvidenceInteger;
  readonly accountAuthzVersion: PreparedEvidenceInteger;
  readonly profileAccountAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolId: string | null;
  readonly poolAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolMemberAccountAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolMemberAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolGrantAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolGrantProfileAuthzVersion: PreparedEvidenceInteger | null;
  readonly poolGrantPoolAuthzVersion: PreparedEvidenceInteger | null;
  readonly customerMeteringPolicyId: string;
  readonly customerMeteringPolicyVersion: PreparedEvidenceInteger;
  readonly providerMeteringPolicyId: string;
  readonly providerMeteringPolicyVersion: PreparedEvidenceInteger;
  readonly contractAttestationId: string;
  readonly customerPriceVersion: string | null;
  readonly supplierCostVersion: string | null;
  /** Migration 029 compiler/fingerprint snapshot. */
  readonly requestFingerprint?: string;
  readonly requestFingerprintVersion?: string;
  readonly payloadCompilerVersion?: string;
  readonly usageEstimatorVersion?: string;
  readonly payloadSha256: string;
  readonly usage: PreparedRequestUsageEnvelope;
  readonly maxHoldCurrency: string | null;
  readonly maxHoldMinorUnits: PreparedEvidenceInteger;
  readonly dispatchDeadline: string | Date;
  readonly expiresAt: string | Date;
  readonly retryBudget: number;
  readonly verifierKeyId: string;
  readonly signatureBase64: string;
  readonly audit: PreparedRequestEvidenceAudit;
}

export interface PreparedRequestEvidenceRecord {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly supplyMode: PreparedEvidenceSupplyMode;
  /** Owner identity is carried from the signed, persisted evidence for health scoping. */
  readonly accountOwnerKind?: PreparedEvidenceOwnerKind;
  readonly publicModel: string;
  readonly protocol: PreparedEvidenceProtocol;
  readonly requestedModel?: string;
  readonly mappedModel?: string;
  readonly resolvedModel?: string;
  readonly modelResolution?: ModelResolutionProvenance;
  readonly clientProtocol?: PreparedEvidenceProtocol;
  readonly providerProtocol?: PreparedEvidenceProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  readonly requestFingerprint?: string;
  readonly requestFingerprintVersion?: string;
  readonly payloadCompilerVersion?: string;
  readonly usageEstimatorVersion?: string;
  readonly endpoint: string;
  readonly upstreamId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly routeTargetMode: PreparedEvidenceTargetMode;
  readonly payloadSha256: string;
  readonly statementSha256: string;
  readonly status: 'registered' | 'claimed';
  readonly claimedAt: string | null;
  readonly claimedAttemptId: string | null;
  readonly expiresAt: string;
}

export interface PreparedRequestEvidenceClaimOptions {
  /** Digest of the in-memory payload that will be sent after the claim. */
  readonly payloadSha256?: string;
}

export interface PreparedRequestEvidenceWriteOptions {
  /** Join a caller-owned SQL transaction; absent means this service opens one. */
  readonly executor?: SqlExecutor;
}

export interface PreparedRequestEvidenceRegistrar {
  register(
    input: PreparedRequestEvidenceInput,
    options?: PreparedRequestEvidenceWriteOptions,
  ): Promise<PreparedRequestEvidenceRecord>;
}

export interface PreparedRequestEvidenceDispatchPort {
  /**
   * Read-only dispatch preflight. This validates the currently registered
   * evidence and its bound attempt without claiming either record.
   */
  preflightForDispatch(
    evidenceId: string,
    audit: PreparedRequestEvidenceAudit,
    options?: PreparedRequestEvidenceClaimOptions,
  ): Promise<PreparedRequestEvidenceRecord>;
  claimForDispatch(
    evidenceId: string,
    audit: PreparedRequestEvidenceAudit,
    options?: PreparedRequestEvidenceClaimOptions,
  ): Promise<PreparedRequestEvidenceRecord>;
}

export type TrustedPreparedRequestVerifierKey = KeyObject | string | Uint8Array;
export interface PreparedRequestEvidenceServiceOptions {
  readonly trustedVerifierPublicKeys:
    | ReadonlyMap<string, TrustedPreparedRequestVerifierKey>
    | Readonly<Record<string, TrustedPreparedRequestVerifierKey>>;
  readonly now?: () => Date;
}

export type PreparedRequestEvidenceErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_VERIFIER_KEY'
  | 'SIGNATURE_INVALID'
  | 'EXPIRED'
  | 'AUTHORITY_MISMATCH'
  | 'NOT_FOUND'
  | 'ALREADY_CLAIMED'
  | 'STORAGE_ERROR'
  | 'AUDIT_FAILED';

export class SaasPreparedRequestEvidenceError extends Error {
  constructor(
    readonly code: PreparedRequestEvidenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasPreparedRequestEvidenceError';
  }
}

interface NormalizedEvidence {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly proxyKeyId: string;
  readonly entitlementId: string;
  readonly entitlementVersion: string;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: string;
  readonly modelScopeVersion: string;
  readonly supplyMode: PreparedEvidenceSupplyMode;
  readonly principalKind: PreparedEvidencePrincipalKind;
  readonly principalId: string;
  readonly authzVersion: string;
  readonly configVersion: string;
  readonly projectPolicyVersion: string;
  readonly publicModel: string;
  readonly protocol: PreparedEvidenceProtocol;
  readonly legacyProvenance: boolean;
  readonly modelResolution?: ModelResolutionProvenance;
  readonly clientProtocol?: PreparedEvidenceProtocol;
  readonly providerProtocol?: PreparedEvidenceProtocol;
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  readonly requestFingerprint?: string;
  readonly requestFingerprintVersion?: string;
  readonly payloadCompilerVersion?: string;
  readonly usageEstimatorVersion?: string;
  readonly endpoint: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly routePublicModelId: string;
  readonly routePublicModelVersion: string;
  readonly routeProtocol: PreparedEvidenceProtocol;
  readonly routeTargetMode: PreparedEvidenceTargetMode;
  readonly routeUpstreamId: string;
  readonly upstreamId: string;
  readonly accountOwnerKind: PreparedEvidenceOwnerKind;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly credentialAuthzVersion: string;
  readonly accountAuthzVersion: string;
  readonly profileAccountAuthzVersion: string | null;
  readonly poolId: string | null;
  readonly poolAuthzVersion: string | null;
  readonly poolMemberAccountAuthzVersion: string | null;
  readonly poolMemberAuthzVersion: string | null;
  readonly poolGrantAuthzVersion: string | null;
  readonly poolGrantProfileAuthzVersion: string | null;
  readonly poolGrantPoolAuthzVersion: string | null;
  readonly customerMeteringPolicyId: string;
  readonly customerMeteringPolicyVersion: string;
  readonly providerMeteringPolicyId: string;
  readonly providerMeteringPolicyVersion: string;
  readonly contractAttestationId: string;
  readonly customerPriceVersion: string | null;
  readonly supplierCostVersion: string | null;
  readonly payloadSha256: string;
  readonly usage: {
    readonly inputTotalUpperBound: string;
    readonly inputUncachedUpperBound: string;
    readonly cacheReadUpperBound: string;
    readonly cacheWriteUpperBound: string;
    readonly cacheWrite5mUpperBound: string;
    readonly cacheWrite1hUpperBound: string;
    readonly outputTotalUpperBound: string;
    readonly reasoningOutputUpperBound: string;
    readonly feasibleInputBuckets: readonly string[];
  };
  readonly maxHoldCurrency: string | null;
  readonly maxHoldMinorUnits: string;
  readonly dispatchDeadline: string;
  readonly expiresAt: string;
  readonly retryBudget: number;
  readonly verifierKeyId: string;
  readonly signatureBase64: string;
  readonly audit: Required<PreparedRequestEvidenceAudit>;
}

const INPUT_BUCKETS = new Set(['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']);
const PROTOCOLS = new Set<PreparedEvidenceProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const MAX_BIGINT = 9223372036854775807n;

function fail(code: PreparedRequestEvidenceErrorCode, message: string, cause?: unknown): never {
  throw new SaasPreparedRequestEvidenceError(code, message, cause === undefined ? undefined : { cause });
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${label} is required`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  return text(value, label);
}

function integer(value: unknown, label: string, allowZero = false): string {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) parsed = BigInt(value.trim());
    else fail('INVALID_INPUT', `${label} must be an exact integer`);
  } catch (error) {
    if (error instanceof SaasPreparedRequestEvidenceError) throw error;
    fail('INVALID_INPUT', `${label} must be an exact integer`, error);
  }
  if (parsed < (allowZero ? 0n : 1n) || parsed > MAX_BIGINT) {
    fail('INVALID_INPUT', `${label} is outside the supported integer range`);
  }
  return parsed.toString(10);
}

function nonNegative(value: unknown, label: string): string {
  return integer(value, label, true);
}

function iso(value: unknown, label: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) fail('INVALID_INPUT', `${label} must be a valid timestamp`);
  return date.toISOString();
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) fail('INVALID_INPUT', `${label} is invalid`);
  return value as T;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}

function optionalOperation(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function optionalProtocol(value: unknown, label: string): PreparedEvidenceProtocol | undefined {
  return value === undefined ? undefined : enumValue(value, PROTOCOLS, label);
}

function operationForProtocol(protocol: PreparedEvidenceProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'openai':
      return 'chat.completions';
    case 'gemini':
      return 'generateContent';
    case 'responses':
      return 'responses';
  }
}

function provenanceDigest(value: unknown, label: string): string {
  if (value === undefined || value === null) fail('AUTHORITY_MISMATCH', `${label} is required provenance`);
  return digest(value, label);
}

function normalizeModelResolution(
  value: unknown,
  requestedModel: string,
  resolvedModel: string,
  allowLegacyOmission = false,
): ModelResolutionProvenance | undefined {
  if (value === undefined) {
    if (allowLegacyOmission) return undefined;
    if (requestedModel === resolvedModel) {
      return {
        requestedModel,
        mappedModel: requestedModel,
        resolvedModel,
        mappingSource: 'none',
        mappingVersion: null,
      };
    }
    fail('AUTHORITY_MISMATCH', 'non-identity model resolution provenance is required');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('AUTHORITY_MISMATCH', 'model resolution provenance is invalid');
  }
  const provenance = value as Record<string, unknown>;
  if (provenance.requestedModel !== requestedModel || provenance.resolvedModel !== resolvedModel) {
    fail('AUTHORITY_MISMATCH', 'model resolution provenance is not bound to evidence models');
  }
  const mappedModel = text(provenance.mappedModel, 'modelResolution.mappedModel');
  const mappingSource = provenance.mappingSource;
  if (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard') {
    fail('AUTHORITY_MISMATCH', 'modelResolution.mappingSource is invalid');
  }
  const mappingVersion = provenance.mappingVersion;
  if (
    mappingVersion !== null &&
    (typeof mappingVersion !== 'number' || !Number.isSafeInteger(mappingVersion) || mappingVersion < 1)
  ) {
    fail('AUTHORITY_MISMATCH', 'modelResolution.mappingVersion is invalid');
  }
  if (mappingSource === 'none') {
    if (mappedModel !== requestedModel || resolvedModel !== requestedModel || mappingVersion !== null) {
      fail('AUTHORITY_MISMATCH', 'passthrough model resolution provenance is inconsistent');
    }
  } else if (mappingVersion === null) {
    fail('AUTHORITY_MISMATCH', 'mapped model resolution provenance has no revision');
  }
  return {
    requestedModel,
    mappedModel,
    resolvedModel,
    mappingSource,
    mappingVersion,
  };
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail('INVALID_INPUT', `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizeUsage(input: PreparedRequestUsageEnvelope): NormalizedEvidence['usage'] {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', 'usage is required');
  const usage = {
    inputTotalUpperBound: nonNegative(input.inputTotalUpperBound, 'usage.inputTotalUpperBound'),
    inputUncachedUpperBound: nonNegative(input.inputUncachedUpperBound, 'usage.inputUncachedUpperBound'),
    cacheReadUpperBound: nonNegative(input.cacheReadUpperBound, 'usage.cacheReadUpperBound'),
    cacheWriteUpperBound: nonNegative(input.cacheWriteUpperBound, 'usage.cacheWriteUpperBound'),
    cacheWrite5mUpperBound: nonNegative(input.cacheWrite5mUpperBound, 'usage.cacheWrite5mUpperBound'),
    cacheWrite1hUpperBound: nonNegative(input.cacheWrite1hUpperBound, 'usage.cacheWrite1hUpperBound'),
    outputTotalUpperBound: nonNegative(input.outputTotalUpperBound, 'usage.outputTotalUpperBound'),
    reasoningOutputUpperBound: nonNegative(input.reasoningOutputUpperBound, 'usage.reasoningOutputUpperBound'),
    feasibleInputBuckets: Array.isArray(input.feasibleInputBuckets)
      ? input.feasibleInputBuckets.map((bucket) => text(bucket, 'usage.feasibleInputBuckets'))
      : fail('INVALID_INPUT', 'usage.feasibleInputBuckets is required'),
  };
  if (
    usage.feasibleInputBuckets.length === 0 ||
    new Set(usage.feasibleInputBuckets).size !== usage.feasibleInputBuckets.length
  ) {
    fail('INVALID_INPUT', 'usage.feasibleInputBuckets must be non-empty and unique');
  }
  if (usage.feasibleInputBuckets.some((bucket) => !INPUT_BUCKETS.has(bucket))) {
    fail('INVALID_INPUT', 'usage.feasibleInputBuckets contains an unsupported dimension');
  }
  const inputTotal = BigInt(usage.inputTotalUpperBound);
  if (
    BigInt(usage.inputUncachedUpperBound) > inputTotal ||
    BigInt(usage.cacheReadUpperBound) > inputTotal ||
    BigInt(usage.cacheWriteUpperBound) > inputTotal ||
    BigInt(usage.cacheWrite5mUpperBound) > inputTotal ||
    BigInt(usage.cacheWrite1hUpperBound) > inputTotal ||
    BigInt(usage.reasoningOutputUpperBound) > BigInt(usage.outputTotalUpperBound)
  ) {
    fail('INVALID_INPUT', 'usage envelope exceeds its signed total bounds');
  }
  return usage;
}

function normalizeAudit(input: PreparedRequestEvidenceAudit): Required<PreparedRequestEvidenceAudit> {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', 'audit is required');
  const sourceIp = input.sourceIp ?? null;
  const userAgent = input.userAgent ?? null;
  const requestId = input.requestId ?? null;
  if (sourceIp !== null && typeof sourceIp !== 'string') fail('INVALID_INPUT', 'audit.sourceIp is invalid');
  if (userAgent !== null && typeof userAgent !== 'string') fail('INVALID_INPUT', 'audit.userAgent is invalid');
  if (requestId !== null && typeof requestId !== 'string') fail('INVALID_INPUT', 'audit.requestId is invalid');
  return {
    actorUserId: input.actorUserId === null ? null : text(input.actorUserId, 'audit.actorUserId'),
    entryPoint: text(input.entryPoint, 'audit.entryPoint'),
    sourceIp,
    userAgent,
    requestId,
  };
}

function normalizeInput(
  input: PreparedRequestEvidenceInput,
  forVerification: boolean,
  allowLegacyProvenance = false,
): NormalizedEvidence {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', 'prepared evidence is required');
  const supplyMode = enumValue<PreparedEvidenceSupplyMode>(
    input.supplyMode,
    new Set<PreparedEvidenceSupplyMode>(['byok', 'platform']),
    'supplyMode',
  );
  const principalKind = enumValue<PreparedEvidencePrincipalKind>(
    input.principalKind,
    new Set<PreparedEvidencePrincipalKind>(['member', 'project_service']),
    'principalKind',
  );
  const accountOwnerKind = enumValue<PreparedEvidenceOwnerKind>(
    input.accountOwnerKind,
    new Set<PreparedEvidenceOwnerKind>(['tenant', 'platform']),
    'accountOwnerKind',
  );
  const protocol = enumValue(input.protocol, PROTOCOLS, 'protocol');
  const routeProtocol = enumValue(input.routeProtocol, PROTOCOLS, 'routeProtocol');
  const routeTargetMode = enumValue<PreparedEvidenceTargetMode>(
    input.routeTargetMode,
    new Set<PreparedEvidenceTargetMode>(['tenant_account', 'platform_pool']),
    'routeTargetMode',
  );
  const publicModel = text(input.publicModel, 'publicModel');
  const resolvedModel = text(input.resolvedModel, 'resolvedModel');
  const provenanceValues = [
    input.modelResolution,
    input.clientProtocol,
    input.providerProtocol,
    input.clientOperation,
    input.providerOperation,
    input.requestFingerprint,
    input.requestFingerprintVersion,
    input.payloadCompilerVersion,
    input.usageEstimatorVersion,
  ];
  const legacyProvenance =
    (allowLegacyProvenance || !forVerification) &&
    provenanceValues.every((value) => value === undefined || value === null);
  const normalized: NormalizedEvidence = {
    evidenceId: identifier(input.evidenceId ?? randomUUID(), 'evidenceId'),
    tenantId: identifier(input.tenantId, 'tenantId'),
    projectId: identifier(input.projectId, 'projectId'),
    requestId: identifier(input.requestId, 'requestId'),
    attemptId: identifier(input.attemptId, 'attemptId'),
    attemptOrdinal: input.attemptOrdinal,
    proxyKeyId: identifier(input.proxyKeyId, 'proxyKeyId'),
    entitlementId: identifier(input.entitlementId, 'entitlementId'),
    entitlementVersion: integer(input.entitlementVersion, 'entitlementVersion'),
    supplyProfileId: identifier(input.supplyProfileId, 'supplyProfileId'),
    supplyProfileVersion: integer(input.supplyProfileVersion, 'supplyProfileVersion'),
    modelScopeVersion: integer(input.modelScopeVersion, 'modelScopeVersion'),
    supplyMode,
    principalKind,
    principalId: identifier(input.principalId, 'principalId'),
    authzVersion: integer(input.authzVersion, 'authzVersion'),
    configVersion: integer(input.configVersion, 'configVersion'),
    projectPolicyVersion: integer(input.projectPolicyVersion, 'projectPolicyVersion'),
    publicModel,
    protocol,
    legacyProvenance,
    modelResolution: normalizeModelResolution(input.modelResolution, publicModel, resolvedModel, legacyProvenance),
    clientProtocol: optionalProtocol(input.clientProtocol, 'clientProtocol'),
    providerProtocol: optionalProtocol(input.providerProtocol, 'providerProtocol'),
    clientOperation: optionalOperation(input.clientOperation, 'clientOperation'),
    providerOperation: optionalOperation(input.providerOperation, 'providerOperation'),
    requestFingerprint:
      input.requestFingerprint === undefined
        ? undefined
        : provenanceDigest(input.requestFingerprint, 'requestFingerprint'),
    requestFingerprintVersion:
      input.requestFingerprintVersion === undefined
        ? undefined
        : text(input.requestFingerprintVersion, 'requestFingerprintVersion'),
    payloadCompilerVersion:
      input.payloadCompilerVersion === undefined
        ? undefined
        : text(input.payloadCompilerVersion, 'payloadCompilerVersion'),
    usageEstimatorVersion:
      input.usageEstimatorVersion === undefined
        ? undefined
        : text(input.usageEstimatorVersion, 'usageEstimatorVersion'),
    endpoint: text(input.endpoint, 'endpoint'),
    routeConfigId: identifier(input.routeConfigId, 'routeConfigId'),
    routeConfigVersion: integer(input.routeConfigVersion, 'routeConfigVersion'),
    routePublicModelId: identifier(input.routePublicModelId, 'routePublicModelId'),
    routePublicModelVersion: integer(input.routePublicModelVersion, 'routePublicModelVersion'),
    routeProtocol,
    routeTargetMode,
    routeUpstreamId: identifier(input.routeUpstreamId, 'routeUpstreamId'),
    upstreamId: identifier(input.upstreamId, 'upstreamId'),
    accountOwnerKind,
    accountId: identifier(input.accountId, 'accountId'),
    providerId: identifier(input.providerId, 'providerId'),
    productId: identifier(input.productId, 'productId'),
    resolvedModel,
    dispatchProfileId: identifier(input.dispatchProfileId, 'dispatchProfileId'),
    supplyProfileAuthzVersion: integer(input.supplyProfileAuthzVersion, 'supplyProfileAuthzVersion'),
    credentialId: identifier(input.credentialId, 'credentialId'),
    credentialVersion: integer(input.credentialVersion, 'credentialVersion'),
    credentialAuthzVersion: integer(input.credentialAuthzVersion, 'credentialAuthzVersion'),
    accountAuthzVersion: integer(input.accountAuthzVersion, 'accountAuthzVersion'),
    profileAccountAuthzVersion:
      input.profileAccountAuthzVersion === null || input.profileAccountAuthzVersion === undefined
        ? null
        : integer(input.profileAccountAuthzVersion, 'profileAccountAuthzVersion'),
    poolId: nullableText(input.poolId, 'poolId'),
    poolAuthzVersion:
      input.poolAuthzVersion === null || input.poolAuthzVersion === undefined
        ? null
        : integer(input.poolAuthzVersion, 'poolAuthzVersion'),
    poolMemberAccountAuthzVersion:
      input.poolMemberAccountAuthzVersion === null || input.poolMemberAccountAuthzVersion === undefined
        ? null
        : integer(input.poolMemberAccountAuthzVersion, 'poolMemberAccountAuthzVersion'),
    poolMemberAuthzVersion:
      input.poolMemberAuthzVersion === null || input.poolMemberAuthzVersion === undefined
        ? null
        : integer(input.poolMemberAuthzVersion, 'poolMemberAuthzVersion'),
    poolGrantAuthzVersion:
      input.poolGrantAuthzVersion === null || input.poolGrantAuthzVersion === undefined
        ? null
        : integer(input.poolGrantAuthzVersion, 'poolGrantAuthzVersion'),
    poolGrantProfileAuthzVersion:
      input.poolGrantProfileAuthzVersion === null || input.poolGrantProfileAuthzVersion === undefined
        ? null
        : integer(input.poolGrantProfileAuthzVersion, 'poolGrantProfileAuthzVersion'),
    poolGrantPoolAuthzVersion:
      input.poolGrantPoolAuthzVersion === null || input.poolGrantPoolAuthzVersion === undefined
        ? null
        : integer(input.poolGrantPoolAuthzVersion, 'poolGrantPoolAuthzVersion'),
    customerMeteringPolicyId: identifier(input.customerMeteringPolicyId, 'customerMeteringPolicyId'),
    customerMeteringPolicyVersion: integer(input.customerMeteringPolicyVersion, 'customerMeteringPolicyVersion'),
    providerMeteringPolicyId: identifier(input.providerMeteringPolicyId, 'providerMeteringPolicyId'),
    providerMeteringPolicyVersion: integer(input.providerMeteringPolicyVersion, 'providerMeteringPolicyVersion'),
    contractAttestationId: identifier(input.contractAttestationId, 'contractAttestationId'),
    customerPriceVersion: nullableText(input.customerPriceVersion, 'customerPriceVersion'),
    supplierCostVersion: nullableText(input.supplierCostVersion, 'supplierCostVersion'),
    payloadSha256: digest(input.payloadSha256, 'payloadSha256'),
    usage: normalizeUsage(input.usage),
    maxHoldCurrency:
      input.maxHoldCurrency === null || input.maxHoldCurrency === undefined
        ? null
        : text(input.maxHoldCurrency, 'maxHoldCurrency'),
    maxHoldMinorUnits: nonNegative(input.maxHoldMinorUnits, 'maxHoldMinorUnits'),
    dispatchDeadline: iso(input.dispatchDeadline, 'dispatchDeadline'),
    expiresAt: iso(input.expiresAt, 'expiresAt'),
    retryBudget: input.retryBudget,
    verifierKeyId: text(input.verifierKeyId, 'verifierKeyId'),
    signatureBase64: typeof input.signatureBase64 === 'string' ? input.signatureBase64 : '',
    audit: normalizeAudit(input.audit),
  };
  if (!Number.isSafeInteger(normalized.attemptOrdinal) || normalized.attemptOrdinal < 1) {
    fail('INVALID_INPUT', 'attemptOrdinal must be a positive safe integer');
  }
  if (!Number.isSafeInteger(normalized.retryBudget) || normalized.retryBudget < 0 || normalized.retryBudget > 1000) {
    fail('INVALID_INPUT', 'retryBudget is outside the supported range');
  }
  if (normalized.principalKind === 'project_service' && normalized.principalId !== normalized.projectId) {
    fail('AUTHORITY_MISMATCH', 'project-service prepared evidence principal must be the project');
  }
  if (normalized.protocol !== normalized.routeProtocol) {
    fail('AUTHORITY_MISMATCH', 'protocol does not match route protocol');
  }
  if (normalized.clientProtocol !== undefined && normalized.clientProtocol !== normalized.protocol) {
    fail('AUTHORITY_MISMATCH', 'client protocol does not match evidence protocol');
  }
  if (forVerification && !normalized.legacyProvenance) {
    if (normalized.modelResolution === undefined) {
      fail('AUTHORITY_MISMATCH', 'model resolution provenance is required');
    }
    if (normalized.providerProtocol === undefined) {
      fail('AUTHORITY_MISMATCH', 'provider protocol provenance is required');
    }
    if (normalized.clientOperation === undefined || normalized.providerOperation === undefined) {
      fail('AUTHORITY_MISMATCH', 'client and provider operation provenance is required');
    }
    if (normalized.clientOperation !== operationForProtocol(normalized.protocol)) {
      fail('AUTHORITY_MISMATCH', 'client operation does not match evidence protocol');
    }
    if (normalized.providerOperation !== operationForProtocol(normalized.providerProtocol)) {
      fail('AUTHORITY_MISMATCH', 'provider operation does not match provider protocol');
    }
    if (normalized.requestFingerprint === undefined) {
      fail('AUTHORITY_MISMATCH', 'request fingerprint provenance is required');
    }
    if (normalized.requestFingerprintVersion === undefined) {
      fail('AUTHORITY_MISMATCH', 'request fingerprint version provenance is required');
    }
    if (normalized.payloadCompilerVersion === undefined) {
      fail('AUTHORITY_MISMATCH', 'payload compiler version provenance is required');
    }
    if (normalized.usageEstimatorVersion === undefined) {
      fail('AUTHORITY_MISMATCH', 'usage estimator version provenance is required');
    }
  }
  if (normalized.supplyMode === 'byok') {
    if (
      normalized.routeTargetMode !== 'tenant_account' ||
      normalized.accountOwnerKind !== 'tenant' ||
      normalized.profileAccountAuthzVersion === null ||
      normalized.poolId !== null ||
      normalized.poolAuthzVersion !== null ||
      normalized.poolMemberAccountAuthzVersion !== null ||
      normalized.poolMemberAuthzVersion !== null ||
      normalized.poolGrantAuthzVersion !== null ||
      normalized.poolGrantProfileAuthzVersion !== null ||
      normalized.poolGrantPoolAuthzVersion !== null ||
      normalized.supplierCostVersion !== null ||
      normalized.maxHoldCurrency !== null ||
      normalized.maxHoldMinorUnits !== '0'
    ) {
      fail('AUTHORITY_MISMATCH', 'BYOK evidence has an invalid target or authority shape');
    }
  } else if (
    normalized.routeTargetMode !== 'platform_pool' ||
    normalized.accountOwnerKind !== 'platform' ||
    normalized.profileAccountAuthzVersion !== null ||
    normalized.poolId === null ||
    normalized.poolAuthzVersion === null ||
    normalized.poolMemberAccountAuthzVersion === null ||
    normalized.poolMemberAuthzVersion === null ||
    normalized.poolGrantAuthzVersion === null ||
    normalized.poolGrantProfileAuthzVersion === null ||
    normalized.poolGrantPoolAuthzVersion === null ||
    normalized.customerPriceVersion === null ||
    normalized.supplierCostVersion === null ||
    normalized.maxHoldCurrency === null ||
    !/^[A-Z]{3}$/.test(normalized.maxHoldCurrency)
  ) {
    fail('AUTHORITY_MISMATCH', 'platform evidence has an invalid target or authority shape');
  }
  if (normalized.expiresAt < normalized.dispatchDeadline) {
    fail('EXPIRED', 'evidence expiry precedes its dispatch deadline');
  }
  if (normalized.attemptOrdinal > normalized.retryBudget + 1) {
    fail('AUTHORITY_MISMATCH', 'attempt ordinal exceeds the signed retry budget');
  }
  if (forVerification && normalized.signatureBase64 === '') {
    fail('SIGNATURE_INVALID', 'signature is required');
  }
  return normalized;
}

function statementObject(input: NormalizedEvidence): Record<string, unknown> {
  return {
    schemaVersion: PREPARED_REQUEST_EVIDENCE_SCHEMA_VERSION,
    domain: PREPARED_REQUEST_EVIDENCE_DOMAIN,
    evidenceId: input.evidenceId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    attemptOrdinal: input.attemptOrdinal,
    proxyKeyId: input.proxyKeyId,
    entitlementId: input.entitlementId,
    entitlementVersion: input.entitlementVersion,
    supplyProfileId: input.supplyProfileId,
    supplyProfileVersion: input.supplyProfileVersion,
    modelScopeVersion: input.modelScopeVersion,
    supplyMode: input.supplyMode,
    principalKind: input.principalKind,
    principalId: input.principalId,
    authzVersion: input.authzVersion,
    configVersion: input.configVersion,
    projectPolicyVersion: input.projectPolicyVersion,
    publicModel: input.publicModel,
    protocol: input.protocol,
    ...(input.modelResolution === undefined ? {} : { modelResolution: input.modelResolution }),
    ...(input.providerProtocol === undefined ? {} : { providerProtocol: input.providerProtocol }),
    ...(input.clientOperation === undefined ? {} : { clientOperation: input.clientOperation }),
    ...(input.providerOperation === undefined ? {} : { providerOperation: input.providerOperation }),
    ...(input.requestFingerprint === undefined ? {} : { requestFingerprint: input.requestFingerprint }),
    ...(input.requestFingerprintVersion === undefined
      ? {}
      : { requestFingerprintVersion: input.requestFingerprintVersion }),
    ...(input.payloadCompilerVersion === undefined ? {} : { payloadCompilerVersion: input.payloadCompilerVersion }),
    ...(input.usageEstimatorVersion === undefined ? {} : { usageEstimatorVersion: input.usageEstimatorVersion }),
    endpoint: input.endpoint,
    routeConfigId: input.routeConfigId,
    routeConfigVersion: input.routeConfigVersion,
    routePublicModelId: input.routePublicModelId,
    routePublicModelVersion: input.routePublicModelVersion,
    routeProtocol: input.routeProtocol,
    routeTargetMode: input.routeTargetMode,
    routeUpstreamId: input.routeUpstreamId,
    upstreamId: input.upstreamId,
    accountOwnerKind: input.accountOwnerKind,
    accountId: input.accountId,
    providerId: input.providerId,
    productId: input.productId,
    resolvedModel: input.resolvedModel,
    dispatchProfileId: input.dispatchProfileId,
    supplyProfileAuthzVersion: input.supplyProfileAuthzVersion,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
    credentialAuthzVersion: input.credentialAuthzVersion,
    accountAuthzVersion: input.accountAuthzVersion,
    profileAccountAuthzVersion: input.profileAccountAuthzVersion,
    poolId: input.poolId,
    poolAuthzVersion: input.poolAuthzVersion,
    poolMemberAccountAuthzVersion: input.poolMemberAccountAuthzVersion,
    poolMemberAuthzVersion: input.poolMemberAuthzVersion,
    poolGrantAuthzVersion: input.poolGrantAuthzVersion,
    poolGrantProfileAuthzVersion: input.poolGrantProfileAuthzVersion,
    poolGrantPoolAuthzVersion: input.poolGrantPoolAuthzVersion,
    customerMeteringPolicyId: input.customerMeteringPolicyId,
    customerMeteringPolicyVersion: input.customerMeteringPolicyVersion,
    providerMeteringPolicyId: input.providerMeteringPolicyId,
    providerMeteringPolicyVersion: input.providerMeteringPolicyVersion,
    contractAttestationId: input.contractAttestationId,
    customerPriceVersion: input.customerPriceVersion,
    supplierCostVersion: input.supplierCostVersion,
    payloadSha256: input.payloadSha256,
    usage: input.usage,
    maxHoldCurrency: input.maxHoldCurrency,
    maxHoldMinorUnits: input.maxHoldMinorUnits,
    dispatchDeadline: input.dispatchDeadline,
    expiresAt: input.expiresAt,
    retryBudget: input.retryBudget,
    verifierKeyId: input.verifierKeyId,
  };
}

export function canonicalPreparedRequestEvidencePayload(input: PreparedRequestEvidenceInput): string {
  if (input.evidenceId === undefined) fail('INVALID_INPUT', 'evidenceId is required for signed evidence');
  const normalized = normalizeInput(input, false);
  return `${PREPARED_REQUEST_EVIDENCE_DOMAIN}\n${JSON.stringify(statementObject(normalized))}`;
}

function statementDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function keyFor(
  keys: PreparedRequestEvidenceServiceOptions['trustedVerifierPublicKeys'],
  keyId: string,
): TrustedPreparedRequestVerifierKey {
  const value =
    keys instanceof Map
      ? keys.get(keyId)
      : (keys as Readonly<Record<string, TrustedPreparedRequestVerifierKey>>)[keyId];
  if (!value) fail('UNKNOWN_VERIFIER_KEY', 'trusted prepared-evidence verifier key is not configured');
  return value;
}

function verifyEvidenceSignature(
  input: NormalizedEvidence,
  keys: PreparedRequestEvidenceServiceOptions['trustedVerifierPublicKeys'],
): string {
  if (!input.signatureBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signatureBase64)) {
    fail('SIGNATURE_INVALID', 'prepared evidence signature is invalid');
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signatureBase64, 'base64');
    if (signature.length !== 64) fail('SIGNATURE_INVALID', 'prepared evidence signature is invalid');
  } catch (error) {
    if (error instanceof SaasPreparedRequestEvidenceError) throw error;
    fail('SIGNATURE_INVALID', 'prepared evidence signature is invalid', error);
  }
  let key: KeyObject;
  try {
    const configured = keyFor(keys, input.verifierKeyId);
    key =
      typeof configured === 'string' || configured instanceof Uint8Array
        ? createPublicKey(configured instanceof Uint8Array ? Buffer.from(configured) : configured)
        : configured;
  } catch (error) {
    fail('UNKNOWN_VERIFIER_KEY', 'trusted prepared-evidence verifier key is invalid', error);
  }
  const canonical = `${PREPARED_REQUEST_EVIDENCE_DOMAIN}\n${JSON.stringify(statementObject(input))}`;
  let verified = false;
  try {
    verified = verifySignature(null, Buffer.from(canonical, 'utf8'), key, signature);
  } catch (error) {
    fail('SIGNATURE_INVALID', 'prepared evidence signature verification failed', error);
  }
  if (!verified) fail('SIGNATURE_INVALID', 'prepared evidence signature verification failed');
  return statementDigest(canonical);
}

type EvidenceRow = Record<string, unknown>;
type LockMode = 'UPDATE';

interface EvidenceLockContext {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly proxyKeyId: string;
  readonly principalKind: PreparedEvidencePrincipalKind;
  readonly principalId: string;
  readonly supplyMode: PreparedEvidenceSupplyMode;
  readonly supplyProfileId: string;
  readonly dispatchProfileId: string;
  readonly poolId: string | null;
  readonly accountOwnerKind: PreparedEvidenceOwnerKind;
  readonly accountId: string;
  readonly providerId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly customerMeteringPolicyId: string;
  readonly providerMeteringPolicyId: string;
  readonly statementSha256: string;
  readonly payloadSha256: string;
}

const EVIDENCE_COLUMNS = [
  'id',
  'schema_version',
  'tenant_id',
  'project_id',
  'request_id',
  'attempt_id',
  'attempt_ordinal',
  'proxy_key_id',
  'entitlement_id',
  'entitlement_version',
  'supply_profile_id',
  'supply_profile_version',
  'model_scope_version',
  'supply_mode',
  'principal_kind',
  'principal_id',
  'authz_version',
  'config_version',
  'project_policy_version',
  'public_model',
  'protocol',
  'model_resolution_requested_model',
  'model_resolution_mapped_model',
  'model_resolution_mapping_source',
  'model_resolution_mapping_version',
  'provider_protocol',
  'client_operation',
  'provider_operation',
  'request_fingerprint',
  'request_fingerprint_version',
  'payload_compiler_version',
  'usage_estimator_version',
  'endpoint',
  'route_config_id',
  'route_config_version',
  'route_public_model_id',
  'route_public_model_version',
  'route_protocol',
  'route_target_mode',
  'route_upstream_id',
  'upstream_id',
  'account_owner_kind',
  'account_id',
  'provider_id',
  'product_id',
  'resolved_model',
  'dispatch_profile_id',
  'supply_profile_authz_version',
  'credential_id',
  'credential_version',
  'credential_authz_version',
  'account_authz_version',
  'profile_account_authz_version',
  'pool_id',
  'pool_authz_version',
  'pool_member_account_authz_version',
  'pool_member_authz_version',
  'pool_grant_authz_version',
  'pool_grant_profile_authz_version',
  'pool_grant_pool_authz_version',
  'customer_metering_policy_id',
  'customer_metering_policy_version',
  'provider_metering_policy_id',
  'provider_metering_policy_version',
  'contract_attestation_id',
  'customer_price_version',
  'supplier_cost_version',
  'payload_sha256',
  'usage_input_total_upper_bound',
  'usage_input_uncached_upper_bound',
  'usage_cache_read_upper_bound',
  'usage_cache_write_upper_bound',
  'usage_cache_write_5m_upper_bound',
  'usage_cache_write_1h_upper_bound',
  'usage_output_total_upper_bound',
  'usage_reasoning_output_upper_bound',
  'usage_feasible_input_buckets',
  'max_hold_currency',
  'max_hold_minor_units',
  'dispatch_deadline',
  'expires_at',
  'retry_budget',
  'verifier_key_id',
  'signature_base64',
  'statement_sha256',
  'status',
] as const;

function evidenceValues(input: NormalizedEvidence, statementSha256: string): readonly unknown[] {
  return [
    input.evidenceId,
    PREPARED_REQUEST_EVIDENCE_SCHEMA_VERSION,
    input.tenantId,
    input.projectId,
    input.requestId,
    input.attemptId,
    input.attemptOrdinal,
    input.proxyKeyId,
    input.entitlementId,
    input.entitlementVersion,
    input.supplyProfileId,
    input.supplyProfileVersion,
    input.modelScopeVersion,
    input.supplyMode,
    input.principalKind,
    input.principalId,
    input.authzVersion,
    input.configVersion,
    input.projectPolicyVersion,
    input.publicModel,
    input.protocol,
    input.modelResolution?.requestedModel,
    input.modelResolution?.mappedModel,
    input.modelResolution?.mappingSource,
    input.modelResolution?.mappingVersion,
    input.providerProtocol,
    input.clientOperation,
    input.providerOperation,
    input.requestFingerprint,
    input.requestFingerprintVersion,
    input.payloadCompilerVersion,
    input.usageEstimatorVersion,
    input.endpoint,
    input.routeConfigId,
    input.routeConfigVersion,
    input.routePublicModelId,
    input.routePublicModelVersion,
    input.routeProtocol,
    input.routeTargetMode,
    input.routeUpstreamId,
    input.upstreamId,
    input.accountOwnerKind,
    input.accountId,
    input.providerId,
    input.productId,
    input.resolvedModel,
    input.dispatchProfileId,
    input.supplyProfileAuthzVersion,
    input.credentialId,
    input.credentialVersion,
    input.credentialAuthzVersion,
    input.accountAuthzVersion,
    input.profileAccountAuthzVersion,
    input.poolId,
    input.poolAuthzVersion,
    input.poolMemberAccountAuthzVersion,
    input.poolMemberAuthzVersion,
    input.poolGrantAuthzVersion,
    input.poolGrantProfileAuthzVersion,
    input.poolGrantPoolAuthzVersion,
    input.customerMeteringPolicyId,
    input.customerMeteringPolicyVersion,
    input.providerMeteringPolicyId,
    input.providerMeteringPolicyVersion,
    input.contractAttestationId,
    input.customerPriceVersion,
    input.supplierCostVersion,
    input.payloadSha256,
    input.usage.inputTotalUpperBound,
    input.usage.inputUncachedUpperBound,
    input.usage.cacheReadUpperBound,
    input.usage.cacheWriteUpperBound,
    input.usage.cacheWrite5mUpperBound,
    input.usage.cacheWrite1hUpperBound,
    input.usage.outputTotalUpperBound,
    input.usage.reasoningOutputUpperBound,
    [...input.usage.feasibleInputBuckets],
    input.maxHoldCurrency,
    input.maxHoldMinorUnits,
    input.dispatchDeadline,
    input.expiresAt,
    input.retryBudget,
    input.verifierKeyId,
    input.signatureBase64,
    statementSha256,
    'registered',
  ];
}

function rowCount(result: { rowCount: number | null }, expected: number, label: string): void {
  if (result.rowCount !== expected) fail('STORAGE_ERROR', `${label} affected an unexpected number of rows`);
}

function stringValue(row: EvidenceRow, key: string, label: string): string {
  return text(row[key], label);
}

function sameStored(row: EvidenceRow, key: string, expected: string, label: string): void {
  if (row[key] === undefined || String(row[key]) !== expected) {
    fail('AUTHORITY_MISMATCH', `${label} does not match the signed authority`);
  }
}

function requiredRow<T extends EvidenceRow>(rows: readonly T[], label: string): T {
  if (rows.length !== 1) {
    fail(rows.length === 0 ? 'AUTHORITY_MISMATCH' : 'STORAGE_ERROR', `${label} is missing or ambiguous`);
  }
  const row = rows[0];
  if (!row) fail('STORAGE_ERROR', `${label} row is missing`);
  return row;
}

function rowDate(row: EvidenceRow, key: string, label: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail('STORAGE_ERROR', `${label} timestamp is invalid`);
  return date;
}

function rolesContain(rows: readonly EvidenceRow[], allowed: ReadonlySet<string>): boolean {
  return rows.some(
    (row) =>
      String(row.status) === 'active' &&
      row.revoked_at == null &&
      typeof row.role === 'string' &&
      allowed.has(row.role),
  );
}

function containsModelScope(value: unknown, publicModel: string): boolean {
  return Array.isArray(value) && value.some((item) => item === publicModel);
}

async function queryRows<T extends EvidenceRow>(
  executor: SqlExecutor,
  sql: string,
  values: readonly unknown[],
): Promise<T[]> {
  try {
    const result = await executor.query<T>(sql, values);
    return result.rows;
  } catch (error) {
    if (error instanceof SaasPreparedRequestEvidenceError) throw error;
    fail('STORAGE_ERROR', 'prepared-request evidence authority query failed', error);
  }
}

type EvidenceFenceInput = Pick<
  NormalizedEvidence,
  | 'tenantId'
  | 'projectId'
  | 'principalKind'
  | 'principalId'
  | 'proxyKeyId'
  | 'customerMeteringPolicyId'
  | 'providerMeteringPolicyId'
  | 'supplyMode'
  | 'supplyProfileId'
  | 'dispatchProfileId'
  | 'poolId'
  | 'accountOwnerKind'
  | 'accountId'
  | 'providerId'
  | 'credentialId'
  | 'credentialVersion'
>;

const PROVIDER_RIGHTS_FENCE_KEY = 'saas-authz:provider-rights';

function credentialVersionFenceKey(input: EvidenceFenceInput): string {
  let version: bigint;
  try {
    version = BigInt(input.credentialVersion);
  } catch (error) {
    fail('AUTHORITY_MISMATCH', 'credential version cannot be used for an advisory fence', error);
  }
  if (version < 1n || version > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('AUTHORITY_MISMATCH', 'credential version cannot be used for an advisory fence');
  }
  return saasAdvisoryKey.credentialVersion(
    input.accountOwnerKind,
    input.accountOwnerKind === 'tenant' ? input.tenantId : 'platform',
    input.credentialId,
    Number(version),
  );
}

function evidenceAdvisoryFenceLayers(input: EvidenceFenceInput): readonly (readonly [string, readonly string[]])[] {
  const identityAndCommercial = [
    ...(input.principalKind === 'member' ? [saasAdvisoryKey.user(input.principalId)] : []),
    saasAdvisoryKey.apiKey(input.tenantId, input.projectId, input.proxyKeyId),
    saasAdvisoryKey.commercialCustomer(input.tenantId, input.customerMeteringPolicyId),
    saasAdvisoryKey.commercialProvider(input.providerId, input.providerMeteringPolicyId),
    PROVIDER_RIGHTS_FENCE_KEY,
  ];
  const pools = input.poolId === null ? [] : [saasAdvisoryKey.platformPool(input.poolId)];
  const accounts = [
    input.accountOwnerKind === 'tenant'
      ? saasAdvisoryKey.tenantProviderAccount(input.tenantId, input.accountId)
      : saasAdvisoryKey.platformProviderAccount(input.accountId),
  ];
  const credentials = [
    input.accountOwnerKind === 'tenant'
      ? saasAdvisoryKey.tenantProviderCredential(input.tenantId, input.credentialId)
      : saasAdvisoryKey.platformProviderCredential(input.credentialId),
  ];
  const profiles = [
    saasAdvisoryKey.supplyProfile(input.tenantId, input.supplyProfileId),
    saasAdvisoryKey.supplyProfile(input.tenantId, input.dispatchProfileId),
  ];
  const mappings =
    input.supplyMode === 'byok'
      ? [saasAdvisoryKey.supplyProfileAccount(input.tenantId, input.dispatchProfileId, input.accountId)]
      : [];

  return [
    ['tenant', [saasAdvisoryKey.tenant(input.tenantId)]],
    ['project', [saasAdvisoryKey.project(input.tenantId, input.projectId)]],
    ['identity-commercial', identityAndCommercial],
    ['pools', pools],
    ['profiles', profiles],
    ['provider-accounts', accounts],
    ['credentials', credentials],
    ['versions', [credentialVersionFenceKey(input)]],
    ['mappings', mappings],
    ['members', []],
    ['grants', []],
  ];
}

async function acquireEvidenceAdvisoryFences(tx: SqlExecutor, input: EvidenceFenceInput): Promise<void> {
  for (const [layer, keys] of evidenceAdvisoryFenceLayers(input)) {
    for (const key of sortAndDedupeAdvisoryKeys(keys)) {
      await queryRows<EvidenceRow>(
        tx,
        `/* prepared-evidence:fence-${layer} */ SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`,
        [key],
      );
    }
  }
}

function storedLockText(row: EvidenceRow, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail('STORAGE_ERROR', `${label} is missing from stored prepared evidence`);
  }
  return value;
}

function storedLockNullableText(row: EvidenceRow, key: string, label: string): string | null {
  if (!(key in row)) fail('STORAGE_ERROR', `${label} is missing from stored prepared evidence`);
  if (row[key] === null) return null;
  return storedLockText(row, key, label);
}

function storedLockDigest(row: EvidenceRow, key: string, label: string): string {
  const value = storedLockText(row, key, label);
  if (!/^[0-9a-f]{64}$/.test(value)) fail('STORAGE_ERROR', `${label} is not a SHA-256 digest`);
  return value;
}

function storedEvidenceLockContext(row: EvidenceRow): EvidenceLockContext {
  const supplyMode = row.supply_mode;
  if (supplyMode !== 'byok' && supplyMode !== 'platform') {
    fail('STORAGE_ERROR', 'stored prepared evidence supply mode is invalid');
  }
  const principalKind = row.principal_kind;
  if (principalKind !== 'member' && principalKind !== 'project_service') {
    fail('STORAGE_ERROR', 'stored prepared evidence principal kind is invalid');
  }
  const accountOwnerKind = row.account_owner_kind;
  if (accountOwnerKind !== 'tenant' && accountOwnerKind !== 'platform') {
    fail('STORAGE_ERROR', 'stored prepared evidence account owner kind is invalid');
  }
  const credentialVersion = String(row.credential_version ?? '');
  if (!/^[1-9][0-9]*$/.test(credentialVersion)) {
    fail('STORAGE_ERROR', 'stored prepared evidence credential version is invalid');
  }
  return {
    evidenceId: storedLockText(row, 'id', 'evidence id'),
    tenantId: storedLockText(row, 'tenant_id', 'tenant id'),
    projectId: storedLockText(row, 'project_id', 'project id'),
    requestId: storedLockText(row, 'request_id', 'request id'),
    attemptId: storedLockText(row, 'attempt_id', 'attempt id'),
    proxyKeyId: storedLockText(row, 'proxy_key_id', 'proxy key id'),
    principalKind,
    principalId: storedLockText(row, 'principal_id', 'principal id'),
    supplyMode,
    supplyProfileId: storedLockText(row, 'supply_profile_id', 'supply profile id'),
    dispatchProfileId: storedLockText(row, 'dispatch_profile_id', 'dispatch profile id'),
    poolId: storedLockNullableText(row, 'pool_id', 'pool id'),
    accountOwnerKind,
    accountId: storedLockText(row, 'account_id', 'account id'),
    providerId: storedLockText(row, 'provider_id', 'provider id'),
    credentialId: storedLockText(row, 'credential_id', 'credential id'),
    credentialVersion,
    customerMeteringPolicyId: storedLockText(row, 'customer_metering_policy_id', 'customer metering policy id'),
    providerMeteringPolicyId: storedLockText(row, 'provider_metering_policy_id', 'provider metering policy id'),
    statementSha256: storedLockDigest(row, 'statement_sha256', 'statement digest'),
    payloadSha256: storedLockDigest(row, 'payload_sha256', 'payload digest'),
  };
}

function assertEvidenceLockContext(row: EvidenceRow, expected: EvidenceLockContext): void {
  const actual = storedEvidenceLockContext(row);
  for (const key of [
    'evidenceId',
    'tenantId',
    'projectId',
    'requestId',
    'attemptId',
    'proxyKeyId',
    'principalKind',
    'principalId',
    'supplyMode',
    'supplyProfileId',
    'dispatchProfileId',
    'poolId',
    'accountOwnerKind',
    'accountId',
    'providerId',
    'credentialId',
    'credentialVersion',
    'customerMeteringPolicyId',
    'providerMeteringPolicyId',
    'statementSha256',
    'payloadSha256',
  ] as const) {
    if (actual[key] !== expected[key]) {
      fail('AUTHORITY_MISMATCH', `prepared evidence ${key} changed after its advisory fences were acquired`);
    }
  }
}

async function lockOne<T extends EvidenceRow>(
  executor: SqlExecutor,
  stage: string,
  table: string,
  where: string,
  values: readonly unknown[],
  mode: LockMode | null = null,
): Promise<T> {
  return requiredRow(
    await queryRows<T>(
      executor,
      `/* prepared-evidence:${stage} */ SELECT * FROM ${table} WHERE ${where} LIMIT 2${mode === null ? '' : ` FOR ${mode}`}`,
      values,
    ),
    stage,
  );
}

async function evidenceLockHint(executor: SqlExecutor, evidenceId: string): Promise<EvidenceLockContext> {
  const row = requiredRow(
    await queryRows<EvidenceRow>(
      executor,
      '/* prepared-evidence:evidence-lock-hint */ ' +
        'SELECT id, tenant_id, project_id, request_id, attempt_id, proxy_key_id, principal_kind, principal_id, ' +
        'supply_mode, supply_profile_id, dispatch_profile_id, pool_id, account_owner_kind, account_id, provider_id, ' +
        'credential_id, credential_version, customer_metering_policy_id, provider_metering_policy_id, ' +
        'statement_sha256, payload_sha256 FROM saas_prepared_request_evidence WHERE id = $1 LIMIT 2',
      [evidenceId],
    ),
    'prepared evidence lock hint',
  );
  return storedEvidenceLockContext(row);
}

function compareRequest(row: EvidenceRow, input: NormalizedEvidence): void {
  const pairs: readonly [string, string, string][] = [
    ['tenant_id', input.tenantId, 'request tenant'],
    ['project_id', input.projectId, 'request project'],
    ['proxy_key_id', input.proxyKeyId, 'request key'],
    ['entitlement_id', input.entitlementId, 'request entitlement'],
    ['entitlement_version', input.entitlementVersion, 'request entitlement version'],
    ['supply_profile_id', input.supplyProfileId, 'request profile'],
    ['supply_profile_version', input.supplyProfileVersion, 'request profile version'],
    ['model_scope_version', input.modelScopeVersion, 'request model-scope version'],
    ['supply_mode', input.supplyMode, 'request supply mode'],
    ['principal_kind', input.principalKind, 'request principal kind'],
    ['principal_id', input.principalId, 'request principal'],
    ['authz_version', input.authzVersion, 'request authz version'],
    ['config_version', input.configVersion, 'request config version'],
    ['project_policy_version', input.projectPolicyVersion, 'request policy version'],
    ['public_model', input.publicModel, 'request public model'],
    ['protocol', input.protocol, 'request protocol'],
    ['request_fingerprint', input.requestFingerprint ?? '', 'request fingerprint'],
    ['request_fingerprint_version', input.requestFingerprintVersion ?? '', 'request fingerprint version'],
    ['endpoint', input.endpoint, 'request endpoint'],
    ['route_config_id', input.routeConfigId, 'request route'],
    ['route_config_version', input.routeConfigVersion, 'request route version'],
    ['route_public_model_id', input.routePublicModelId, 'request route model'],
    ['route_public_model_version', input.routePublicModelVersion, 'request route model version'],
    ['route_protocol', input.routeProtocol, 'request route protocol'],
    ['route_target_mode', input.routeTargetMode, 'request target mode'],
    ['route_upstream_id', input.routeUpstreamId, 'request route upstream'],
    ['customer_metering_policy_id', input.customerMeteringPolicyId, 'request customer policy'],
    ['customer_metering_policy_version', input.customerMeteringPolicyVersion, 'request customer policy version'],
    ['provider_metering_policy_id', input.providerMeteringPolicyId, 'request provider policy'],
    ['provider_metering_policy_version', input.providerMeteringPolicyVersion, 'request provider policy version'],
    ['contract_attestation_id', input.contractAttestationId, 'request attestation'],
    ['customer_price_version', input.customerPriceVersion ?? '', 'request customer price'],
  ];
  for (const [key, expected, label] of pairs) {
    if (input.legacyProvenance && (key === 'request_fingerprint' || key === 'request_fingerprint_version')) {
      continue;
    }
    if (expected === '' && row[key] == null) continue;
    sameStored(row, key, expected, label);
  }
}

function compareAttempt(row: EvidenceRow, input: NormalizedEvidence): void {
  const persistedProvenance = input.legacyProvenance
    ? {
        requestedModel: '',
        mappedModel: '',
        mappingSource: '',
        mappingVersion: '',
        providerProtocol: '',
        clientOperation: '',
        providerOperation: '',
        requestFingerprint: '',
        requestFingerprintVersion: '',
        payloadCompilerVersion: '',
        usageEstimatorVersion: '',
        payloadSha256: '',
      }
    : {
        requestedModel: input.modelResolution?.requestedModel ?? '',
        mappedModel: input.modelResolution?.mappedModel ?? '',
        mappingSource: input.modelResolution?.mappingSource ?? '',
        mappingVersion:
          input.modelResolution?.mappingVersion === null || input.modelResolution?.mappingVersion === undefined
            ? ''
            : String(input.modelResolution.mappingVersion),
        providerProtocol: input.providerProtocol ?? '',
        clientOperation: input.clientOperation ?? '',
        providerOperation: input.providerOperation ?? '',
        requestFingerprint: input.requestFingerprint ?? '',
        requestFingerprintVersion: input.requestFingerprintVersion ?? '',
        payloadCompilerVersion: input.payloadCompilerVersion ?? '',
        usageEstimatorVersion: input.usageEstimatorVersion ?? '',
        payloadSha256: input.payloadSha256,
      };
  const pairs: readonly [string, string, string][] = [
    ['request_id', input.requestId, 'attempt request'],
    ['ordinal', String(input.attemptOrdinal), 'attempt ordinal'],
    ['upstream_id', input.upstreamId, 'attempt upstream'],
    ['account_id', input.accountId, 'attempt account'],
    ['provider_id', input.providerId, 'attempt provider'],
    ['product_id', input.productId, 'attempt product'],
    ['resolved_model', input.resolvedModel, 'attempt resolved model'],
    ['protocol', input.protocol, 'attempt protocol'],
    ['model_resolution_requested_model', persistedProvenance.requestedModel, 'attempt requested model provenance'],
    ['model_resolution_mapped_model', persistedProvenance.mappedModel, 'attempt mapped model provenance'],
    ['model_resolution_mapping_source', persistedProvenance.mappingSource, 'attempt mapping source provenance'],
    ['model_resolution_mapping_version', persistedProvenance.mappingVersion, 'attempt mapping version provenance'],
    ['provider_protocol', persistedProvenance.providerProtocol, 'attempt provider protocol provenance'],
    ['client_operation', persistedProvenance.clientOperation, 'attempt client operation provenance'],
    ['provider_operation', persistedProvenance.providerOperation, 'attempt provider operation provenance'],
    ['request_fingerprint', persistedProvenance.requestFingerprint, 'attempt request fingerprint'],
    [
      'request_fingerprint_version',
      persistedProvenance.requestFingerprintVersion,
      'attempt request fingerprint version',
    ],
    ['payload_compiler_version', persistedProvenance.payloadCompilerVersion, 'attempt payload compiler version'],
    ['usage_estimator_version', persistedProvenance.usageEstimatorVersion, 'attempt usage estimator version'],
    ['payload_sha256', persistedProvenance.payloadSha256, 'attempt payload digest'],
    ['endpoint', input.endpoint, 'attempt endpoint'],
    ['supplier_cost_version', input.supplierCostVersion ?? '', 'attempt cost'],
    ['dispatch_profile_id', input.dispatchProfileId, 'attempt dispatch profile'],
    ['supply_profile_authz_version', input.supplyProfileAuthzVersion, 'attempt profile epoch'],
    ['credential_id', input.credentialId, 'attempt credential'],
    ['credential_version', input.credentialVersion, 'attempt credential version'],
    ['credential_authz_version', input.credentialAuthzVersion, 'attempt credential epoch'],
    ['account_authz_version', input.accountAuthzVersion, 'attempt account epoch'],
    ['pool_id', input.poolId ?? '', 'attempt pool'],
    ['pool_authz_version', input.poolAuthzVersion ?? '', 'attempt pool epoch'],
    ['pool_member_account_authz_version', input.poolMemberAccountAuthzVersion ?? '', 'attempt member account epoch'],
    ['pool_member_authz_version', input.poolMemberAuthzVersion ?? '', 'attempt member epoch'],
    ['pool_grant_authz_version', input.poolGrantAuthzVersion ?? '', 'attempt grant epoch'],
    ['pool_grant_profile_authz_version', input.poolGrantProfileAuthzVersion ?? '', 'attempt grant profile epoch'],
    ['pool_grant_pool_authz_version', input.poolGrantPoolAuthzVersion ?? '', 'attempt grant pool epoch'],
    ['profile_account_authz_version', input.profileAccountAuthzVersion ?? '', 'attempt mapping epoch'],
    ['route_config_id', input.routeConfigId, 'attempt route'],
    ['route_config_version', input.routeConfigVersion, 'attempt route version'],
    ['route_public_model_id', input.routePublicModelId, 'attempt route model'],
    ['route_public_model_version', input.routePublicModelVersion, 'attempt route model version'],
    ['route_protocol', input.routeProtocol, 'attempt route protocol'],
    ['route_target_mode', input.routeTargetMode, 'attempt target mode'],
    ['project_policy_version', input.projectPolicyVersion, 'attempt policy version'],
    ['customer_metering_policy_id', input.customerMeteringPolicyId, 'attempt customer policy'],
    ['customer_metering_policy_version', input.customerMeteringPolicyVersion, 'attempt customer policy version'],
    ['provider_metering_policy_id', input.providerMeteringPolicyId, 'attempt provider policy'],
    ['provider_metering_policy_version', input.providerMeteringPolicyVersion, 'attempt provider policy version'],
    ['contract_attestation_id', input.contractAttestationId, 'attempt attestation'],
    ['customer_price_version', input.customerPriceVersion ?? '', 'attempt price'],
  ];
  for (const [key, expected, label] of pairs) {
    if (expected === '' && row[key] == null) continue;
    sameStored(row, key, expected, label);
  }
  if (row.dispatch_state !== 'not_sent' || row.dispatch_authority_state !== 'bound') {
    fail('AUTHORITY_MISMATCH', 'attempt is not in a dispatchable pre-claim state');
  }
  if (row.prepared_evidence_id != null) {
    fail('ALREADY_CLAIMED', 'attempt already has prepared evidence');
  }
}

export class SaasPreparedRequestEvidenceService {
  private readonly now: () => Date;

  constructor(
    private readonly database: SaasDatabase,
    private readonly options: PreparedRequestEvidenceServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async register(
    input: PreparedRequestEvidenceInput,
    options: PreparedRequestEvidenceWriteOptions = {},
  ): Promise<PreparedRequestEvidenceRecord> {
    const normalized = normalizeInput(input, true);
    const statementSha256 = verifyEvidenceSignature(normalized, this.options.trustedVerifierPublicKeys);
    const work = async (tx: SqlExecutor): Promise<PreparedRequestEvidenceRecord> => {
      await this.revalidateAuthorities(tx, normalized, 'UPDATE');
      const lockedAt = await this.databaseClock(tx);
      this.assertWindow(normalized, lockedAt);
      const placeholders = EVIDENCE_COLUMNS.map((_, index) => `$${String(index + 1)}`).join(', ');
      const result = await tx.query<EvidenceRow>(
        'INSERT INTO saas_prepared_request_evidence (' +
          EVIDENCE_COLUMNS.join(', ') +
          ') VALUES (' +
          placeholders +
          ') RETURNING id, status, claimed_at, claimed_attempt_id, expires_at',
        evidenceValues(normalized, statementSha256),
      );
      rowCount(result, 1, 'prepared evidence registration');
      await this.audit(
        tx,
        normalized,
        'saas_prepared_request_evidence.registered',
        normalized.evidenceId,
        lockedAt.toISOString(),
      );
      const row = result.rows[0];
      if (!row) fail('STORAGE_ERROR', 'prepared evidence registration returned no row');
      return this.recordFromRow(row, normalized, statementSha256);
    };
    try {
      return await (options.executor ? work(options.executor) : this.database.transaction(work));
    } catch (error) {
      throw this.wrapStorage(error, 'Prepared request evidence could not be registered');
    }
  }

  async preflightForDispatch(
    evidenceId: string,
    audit: PreparedRequestEvidenceAudit,
    options: PreparedRequestEvidenceClaimOptions = {},
  ): Promise<PreparedRequestEvidenceRecord> {
    const id = identifier(evidenceId, 'evidenceId');
    const auditContext = normalizeAudit(audit);
    try {
      return await this.database.transaction(async (tx) => {
        const hint = await evidenceLockHint(tx, id);
        await acquireEvidenceAdvisoryFences(tx, hint);
        const request = await lockOne<EvidenceRow>(
          tx,
          'request',
          'saas_requests',
          'tenant_id = $1 AND id = $2',
          [hint.tenantId, hint.requestId],
          null,
        );
        const attempt = await lockOne<EvidenceRow>(
          tx,
          'attempt',
          'saas_attempts',
          'tenant_id = $1 AND id = $2',
          [hint.tenantId, hint.attemptId],
          null,
        );
        const stored = await lockOne<EvidenceRow>(
          tx,
          'evidence-preflight',
          'saas_prepared_request_evidence',
          'id = $1',
          [id],
          null,
        );
        assertEvidenceLockContext(stored, hint);
        if (stored.status !== 'registered') {
          fail('ALREADY_CLAIMED', 'prepared evidence has already been claimed');
        }
        const normalized = normalizeStoredEvidence(stored, auditContext);
        const statementSha256 = verifyEvidenceSignature(normalized, this.options.trustedVerifierPublicKeys);
        if (String(stored.statement_sha256) !== statementSha256) {
          fail('SIGNATURE_INVALID', 'stored prepared evidence statement digest changed');
        }
        this.assertPayloadMatches(normalized, options);
        await this.revalidateAuthorities(tx, normalized, null, {
          prelockedRequest: request,
          prelockedAttempt: attempt,
          fencesAlreadyHeld: true,
        });
        const lockedAt = await this.databaseClock(tx);
        this.assertWindow(normalized, lockedAt);
        return this.recordFromRow(stored, normalized, statementSha256);
      });
    } catch (error) {
      throw this.wrapStorage(error, 'Prepared request evidence preflight failed');
    }
  }

  async claimForDispatch(
    evidenceId: string,
    audit: PreparedRequestEvidenceAudit,
    options: PreparedRequestEvidenceClaimOptions = {},
  ): Promise<PreparedRequestEvidenceRecord> {
    const id = identifier(evidenceId, 'evidenceId');
    const auditContext = normalizeAudit(audit);
    try {
      return await this.database.transaction(async (tx) => {
        const hint = await evidenceLockHint(tx, id);
        await acquireEvidenceAdvisoryFences(tx, hint);
        const request = await lockOne<EvidenceRow>(
          tx,
          'request',
          'saas_requests',
          'tenant_id = $1 AND id = $2',
          [hint.tenantId, hint.requestId],
          'UPDATE',
        );
        const attempt = await lockOne<EvidenceRow>(
          tx,
          'attempt',
          'saas_attempts',
          'tenant_id = $1 AND id = $2',
          [hint.tenantId, hint.attemptId],
          'UPDATE',
        );
        const evidence = await lockOne<EvidenceRow>(
          tx,
          'evidence-claim',
          'saas_prepared_request_evidence',
          'id = $1',
          [id],
          'UPDATE',
        );
        assertEvidenceLockContext(evidence, hint);
        if (evidence.status !== 'registered') {
          fail('ALREADY_CLAIMED', 'prepared evidence has already been claimed');
        }
        const normalized = normalizeStoredEvidence(evidence, auditContext);
        const statementSha256 = verifyEvidenceSignature(normalized, this.options.trustedVerifierPublicKeys);
        if (String(evidence.statement_sha256) !== statementSha256) {
          fail('SIGNATURE_INVALID', 'stored prepared evidence statement digest changed');
        }
        this.assertPayloadMatches(normalized, options);
        await this.revalidateAuthorities(tx, normalized, 'UPDATE', {
          prelockedRequest: request,
          prelockedAttempt: attempt,
          fencesAlreadyHeld: true,
        });
        const lockedAt = await this.databaseClock(tx);
        this.assertWindow(normalized, lockedAt);
        const attemptUpdate = await tx.query(
          'UPDATE saas_attempts ' +
            'SET prepared_evidence_id = $3 ' +
            'WHERE tenant_id = $1 AND id = $2 AND prepared_evidence_id IS NULL ' +
            'RETURNING id',
          [normalized.tenantId, normalized.attemptId, normalized.evidenceId],
        );
        rowCount(attemptUpdate, 1, 'prepared evidence attempt claim');
        const evidenceUpdate = await tx.query<EvidenceRow>(
          'UPDATE saas_prepared_request_evidence ' +
            "SET status = 'claimed', claimed_at = clock_timestamp(), claimed_attempt_id = $3 " +
            "WHERE tenant_id = $1 AND id = $2 AND status = 'registered' " +
            'AND expires_at > clock_timestamp() AND dispatch_deadline > clock_timestamp() ' +
            'AND payload_sha256 = $4 AND statement_sha256 = $5 ' +
            'RETURNING id, status, claimed_at, claimed_attempt_id, expires_at',
          [normalized.tenantId, normalized.evidenceId, normalized.attemptId, normalized.payloadSha256, statementSha256],
        );
        rowCount(evidenceUpdate, 1, 'prepared evidence claim');
        await this.audit(
          tx,
          normalized,
          'saas_prepared_request_evidence.claimed',
          normalized.evidenceId,
          lockedAt.toISOString(),
          auditContext,
        );
        const row = evidenceUpdate.rows[0];
        if (!row) fail('STORAGE_ERROR', 'prepared evidence claim returned no row');
        return this.recordFromRow(row, normalized, statementSha256);
      });
    } catch (error) {
      throw this.wrapStorage(error, 'Prepared request evidence could not be claimed');
    }
  }

  private assertPayloadMatches(input: NormalizedEvidence, options: PreparedRequestEvidenceClaimOptions): void {
    if (options.payloadSha256 !== undefined && options.payloadSha256 !== input.payloadSha256) {
      fail('AUTHORITY_MISMATCH', 'dispatch payload does not match the claimed prepared evidence');
    }
  }

  private async databaseClock(tx: SqlExecutor): Promise<Date> {
    const row = requiredRow(
      await queryRows<EvidenceRow>(tx, '/* prepared-evidence:clock */ SELECT clock_timestamp() AS locked_at', []),
      'database clock',
    );
    return rowDate(row, 'locked_at', 'database clock') ?? fail('STORAGE_ERROR', 'database clock is null');
  }

  private assertWindow(input: NormalizedEvidence, lockedAt: Date): void {
    const deadline = new Date(input.dispatchDeadline);
    const expiresAt = new Date(input.expiresAt);
    if (deadline <= lockedAt || expiresAt <= lockedAt) {
      fail('EXPIRED', 'prepared evidence is expired at the database clock');
    }
  }

  private async revalidateAuthorities(
    tx: SqlExecutor,
    input: NormalizedEvidence,
    attemptMode: LockMode | null,
    options: {
      readonly prelockedRequest?: EvidenceRow;
      readonly prelockedAttempt?: EvidenceRow;
      readonly fencesAlreadyHeld?: boolean;
    } = {},
  ): Promise<void> {
    if (!options.fencesAlreadyHeld) await acquireEvidenceAdvisoryFences(tx, input);
    const tenant = await lockOne<EvidenceRow>(tx, 'tenant', 'saas_tenants', 'id = $1', [input.tenantId]);
    if (tenant.status !== 'active') fail('AUTHORITY_MISMATCH', 'tenant is not active');

    const project = await lockOne<EvidenceRow>(tx, 'project', 'saas_projects', 'tenant_id = $1 AND id = $2', [
      input.tenantId,
      input.projectId,
    ]);
    sameStored(project, 'inference_policy_version', input.projectPolicyVersion, 'project policy version');
    if (project.inference_policy_status !== 'active') {
      fail('AUTHORITY_MISMATCH', 'project inference policy is not active');
    }
    const policy = await lockOne<EvidenceRow>(
      tx,
      'project-policy',
      'saas_project_inference_policy_versions',
      'tenant_id = $1 AND project_id = $2 AND version = $3',
      [input.tenantId, input.projectId, input.projectPolicyVersion],
      null,
    );
    if (String(policy.version) !== input.projectPolicyVersion || policy.status !== 'active') {
      fail('AUTHORITY_MISMATCH', 'project inference policy version is not active');
    }

    let tenantMemberships: readonly EvidenceRow[] | null = null;
    let projectMemberships: readonly EvidenceRow[] | null = null;
    if (input.principalKind === 'member') {
      const principal = await lockOne<EvidenceRow>(tx, 'principal', 'saas_users', 'id = $1', [input.principalId]);
      if (principal.disabled_at != null || principal.anonymized_at != null) {
        fail('AUTHORITY_MISMATCH', 'principal is disabled or anonymized');
      }

      tenantMemberships = await queryRows<EvidenceRow>(
        tx,
        '/* prepared-evidence:tenant-membership */ SELECT * FROM saas_memberships WHERE tenant_id = $1 AND user_id = $2',
        [input.tenantId, input.principalId],
      );
      if (!rolesContain(tenantMemberships, new Set(['owner', 'admin', 'developer']))) {
        fail('AUTHORITY_MISMATCH', 'tenant membership is not inference-capable');
      }
      projectMemberships = await queryRows<EvidenceRow>(
        tx,
        '/* prepared-evidence:project-membership */ SELECT * FROM saas_project_memberships WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3',
        [input.tenantId, input.projectId, input.principalId],
      );
      if (!rolesContain(projectMemberships, new Set(['owner', 'admin', 'developer']))) {
        fail('AUTHORITY_MISMATCH', 'project membership is not inference-capable');
      }
    } else if (input.principalId !== input.projectId) {
      fail('AUTHORITY_MISMATCH', 'project-service principal is not bound to the project');
    }

    const key = await lockOne<EvidenceRow>(
      tx,
      'key',
      'saas_api_keys',
      'tenant_id = $1 AND project_id = $2 AND id = $3',
      [input.tenantId, input.projectId, input.proxyKeyId],
    );
    if (
      (key.execution_principal_type ?? key.principal_kind) !== input.principalKind ||
      (key.execution_principal_id ?? key.principal_id) !== input.principalId ||
      key.entitlement_id !== input.entitlementId ||
      key.supply_profile_id !== input.supplyProfileId ||
      key.supply_mode !== input.supplyMode ||
      String(key.authz_version) !== input.authzVersion ||
      String(key.entitlement_authz_version) !== input.entitlementVersion ||
      String(key.supply_profile_authz_version) !== input.supplyProfileVersion ||
      String(key.model_scope_version) !== input.modelScopeVersion ||
      (input.principalKind === 'member' && key.principal_user_id !== input.principalId) ||
      (input.principalKind === 'project_service' && key.principal_user_id !== null) ||
      key.status !== 'active' ||
      key.revoked_at != null ||
      !containsModelScope(key.model_scopes, input.publicModel)
    ) {
      fail('AUTHORITY_MISMATCH', 'API-key authority does not match prepared evidence');
    }

    const request =
      options.prelockedRequest ??
      (await lockOne<EvidenceRow>(
        tx,
        'request',
        'saas_requests',
        'tenant_id = $1 AND id = $2',
        [input.tenantId, input.requestId],
        'UPDATE',
      ));
    compareRequest(request, input);
    const attempt =
      options.prelockedAttempt ??
      (await lockOne<EvidenceRow>(
        tx,
        'attempt',
        'saas_attempts',
        'tenant_id = $1 AND id = $2',
        [input.tenantId, input.attemptId],
        attemptMode,
      ));
    compareAttempt(attempt, input);

    const entitlement = await lockOne<EvidenceRow>(
      tx,
      'entitlement',
      'saas_project_entitlements',
      'tenant_id = $1 AND project_id = $2 AND id = $3',
      [input.tenantId, input.projectId, input.entitlementId],
    );
    sameStored(entitlement, 'authz_version', input.entitlementVersion, 'entitlement version');
    sameStored(entitlement, 'supply_profile_id', input.supplyProfileId, 'entitlement profile');
    sameStored(entitlement, 'supply_mode', input.supplyMode, 'entitlement supply mode');

    const profile = await lockOne<EvidenceRow>(
      tx,
      'profile',
      'saas_supply_profiles',
      'tenant_id = $1 AND id = $2 AND supply_mode = $3',
      [input.tenantId, input.supplyProfileId, input.supplyMode],
    );
    if (profile.status !== 'active') fail('AUTHORITY_MISMATCH', 'supply profile is not active');
    sameStored(profile, 'authz_version', input.supplyProfileVersion, 'supply profile version');

    const route = await lockOne<EvidenceRow>(
      tx,
      'route',
      'saas_route_config_versions',
      'tenant_id = $1 AND project_id = $2 AND route_id = $3 AND version = $4',
      [input.tenantId, input.projectId, input.routeConfigId, input.routeConfigVersion],
    );
    sameStored(route, 'route_id', input.routeConfigId, 'route config');
    sameStored(route, 'version', input.routeConfigVersion, 'route config version');
    if (
      route.status !== 'active' ||
      route.public_model_id !== input.routePublicModelId ||
      String(route.public_model_version) !== input.routePublicModelVersion ||
      route.protocol !== input.routeProtocol ||
      route.target_mode !== input.routeTargetMode ||
      route.upstream_id !== input.routeUpstreamId ||
      route.endpoint !== input.endpoint
    ) {
      fail('AUTHORITY_MISMATCH', 'route authority does not match prepared evidence');
    }

    const commercial = await lockOne<EvidenceRow>(
      tx,
      'commercial',
      'saas_route_config_commercial_authorities',
      'tenant_id = $1 AND project_id = $2 AND route_id = $3 AND route_version = $4',
      [input.tenantId, input.projectId, input.routeConfigId, input.routeConfigVersion],
    );
    sameStored(commercial, 'customer_policy_id', input.customerMeteringPolicyId, 'customer policy');
    sameStored(commercial, 'customer_policy_version', input.customerMeteringPolicyVersion, 'customer policy version');
    sameStored(commercial, 'provider_policy_id', input.providerMeteringPolicyId, 'provider policy');
    sameStored(commercial, 'provider_policy_version', input.providerMeteringPolicyVersion, 'provider policy version');
    sameStored(commercial, 'contract_attestation_id', input.contractAttestationId, 'contract attestation');
    if (
      (input.customerPriceVersion === null && commercial.customer_price_version != null) ||
      (input.customerPriceVersion !== null &&
        String(commercial.customer_price_version) !== input.customerPriceVersion) ||
      (input.supplierCostVersion === null && commercial.supplier_cost_version != null) ||
      (input.supplierCostVersion !== null && String(commercial.supplier_cost_version) !== input.supplierCostVersion)
    ) {
      fail('AUTHORITY_MISMATCH', 'commercial authority versions do not match prepared evidence');
    }

    const attestation = await lockOne<EvidenceRow>(
      tx,
      'attestation',
      'saas_contract_test_attestations',
      'tenant_id = $1 AND project_id = $2 AND id = $3',
      [input.tenantId, input.projectId, input.contractAttestationId],
    );
    if (attestation.verification_result !== 'verified') {
      fail('AUTHORITY_MISMATCH', 'contract attestation is not verified');
    }

    let account: EvidenceRow;
    let credential: EvidenceRow;
    let mapping: EvidenceRow | null = null;
    let pool: EvidenceRow | null = null;
    let member: EvidenceRow | null = null;
    let grant: EvidenceRow | null = null;
    let customerPrice: EvidenceRow | null = null;
    let supplierCost: EvidenceRow | null = null;

    if (input.accountOwnerKind === 'tenant') {
      account = await lockOne<EvidenceRow>(
        tx,
        'account',
        'saas_tenant_provider_accounts',
        'tenant_id = $1 AND id = $2',
        [input.tenantId, input.accountId],
      );
      this.assertAccount(account, input);
      credential = await lockOne<EvidenceRow>(
        tx,
        'credential',
        'saas_tenant_provider_credentials',
        'tenant_id = $1 AND id = $2 AND account_id = $3',
        [input.tenantId, input.credentialId, input.accountId],
      );
      this.assertCredential(credential, input);
      mapping = await lockOne<EvidenceRow>(
        tx,
        'mapping',
        'saas_tenant_provider_supply_profile_accounts',
        'tenant_id = $1 AND supply_profile_id = $2 AND account_id = $3',
        [input.tenantId, input.dispatchProfileId, input.accountId],
      );
      if (
        mapping.status !== 'active' ||
        String(mapping.authz_version) !== input.profileAccountAuthzVersion ||
        String(mapping.account_authz_version) !== input.accountAuthzVersion
      ) {
        fail('AUTHORITY_MISMATCH', 'BYOK mapping authority does not match prepared evidence');
      }
    } else {
      account = await lockOne<EvidenceRow>(tx, 'account', 'saas_platform_provider_accounts', 'id = $1', [
        input.accountId,
      ]);
      this.assertAccount(account, input);
      credential = await lockOne<EvidenceRow>(
        tx,
        'credential',
        'saas_platform_provider_credentials',
        'id = $1 AND account_id = $2',
        [input.credentialId, input.accountId],
      );
      this.assertCredential(credential, input);
      pool = await lockOne<EvidenceRow>(tx, 'pool', 'saas_platform_provider_pools', 'id = $1', [input.poolId]);
      if (pool.status !== 'active' || String(pool.authz_version) !== input.poolAuthzVersion) {
        fail('AUTHORITY_MISMATCH', 'platform pool authority does not match prepared evidence');
      }
      member = await lockOne<EvidenceRow>(
        tx,
        'pool-member',
        'saas_platform_provider_pool_members',
        'pool_id = $1 AND account_id = $2',
        [input.poolId, input.accountId],
      );
      if (
        member.status !== 'active' ||
        String(member.authz_version) !== input.poolMemberAuthzVersion ||
        String(member.account_authz_version) !== input.poolMemberAccountAuthzVersion
      ) {
        fail('AUTHORITY_MISMATCH', 'platform pool member authority does not match prepared evidence');
      }
      grant = await lockOne<EvidenceRow>(
        tx,
        'pool-grant',
        'saas_platform_provider_pool_grants',
        'pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3',
        [input.poolId, input.tenantId, input.dispatchProfileId],
      );
      if (
        grant.status !== 'active' ||
        String(grant.authz_version) !== input.poolGrantAuthzVersion ||
        String(grant.profile_authz_version) !== input.poolGrantProfileAuthzVersion ||
        String(grant.pool_authz_version) !== input.poolGrantPoolAuthzVersion
      ) {
        fail('AUTHORITY_MISMATCH', 'platform pool grant authority does not match prepared evidence');
      }
    }

    if (input.customerPriceVersion !== null) {
      customerPrice = await lockOne<EvidenceRow>(tx, 'customer-price', 'saas_customer_price_versions', 'id = $1', [
        input.customerPriceVersion,
      ]);
    }
    if (input.supplierCostVersion !== null) {
      supplierCost = await lockOne<EvidenceRow>(tx, 'supplier-cost', 'saas_supplier_cost_versions', 'id = $1', [
        input.supplierCostVersion,
      ]);
    }

    const lockedAt = await this.databaseClock(tx);
    this.assertAuthorityWindows(
      lockedAt,
      input,
      tenantMemberships,
      projectMemberships,
      key,
      entitlement,
      profile,
      attestation,
      account,
      credential,
      mapping,
      pool,
      member,
      grant,
      customerPrice,
      supplierCost,
    );
  }

  private assertAuthorityWindows(
    lockedAt: Date,
    input: NormalizedEvidence,
    tenantMemberships: readonly EvidenceRow[] | null,
    projectMemberships: readonly EvidenceRow[] | null,
    key: EvidenceRow,
    entitlement: EvidenceRow,
    profile: EvidenceRow,
    attestation: EvidenceRow,
    account: EvidenceRow,
    credential: EvidenceRow,
    mapping: EvidenceRow | null,
    pool: EvidenceRow | null,
    member: EvidenceRow | null,
    grant: EvidenceRow | null,
    customerPrice: EvidenceRow | null,
    supplierCost: EvidenceRow | null,
  ): void {
    const inferenceRoles = new Set(['owner', 'admin', 'developer']);
    if (input.principalKind === 'member') {
      if (tenantMemberships === null || projectMemberships === null) {
        fail('AUTHORITY_MISMATCH', 'member-bound evidence is missing current membership authority');
      }
      this.assertMembershipWindows(tenantMemberships, inferenceRoles, lockedAt, 'tenant membership');
      this.assertMembershipWindows(projectMemberships, inferenceRoles, lockedAt, 'project membership');
    }
    this.assertTimeWindow(key, lockedAt, 'API key');
    this.assertTimeWindow(entitlement, lockedAt, 'entitlement');
    if (
      entitlement.status !== 'active' &&
      !(
        entitlement.status === 'superseded' &&
        rowDate(entitlement, 'superseded_at', 'entitlement superseded_at') !== null &&
        (rowDate(entitlement, 'superseded_at', 'entitlement superseded_at') as Date) <= lockedAt
      )
    ) {
      fail('AUTHORITY_MISMATCH', 'entitlement is not active or an effective superseded entitlement');
    }
    this.assertTimeWindow(profile, lockedAt, 'supply profile');
    this.assertTimeWindow(attestation, lockedAt, 'contract attestation');
    this.assertTimeWindow(account, lockedAt, 'provider account');
    this.assertTimeWindow(credential, lockedAt, 'credential');
    if (mapping) this.assertTimeWindow(mapping, lockedAt, 'BYOK mapping');
    if (pool) this.assertTimeWindow(pool, lockedAt, 'platform pool');
    if (member) this.assertTimeWindow(member, lockedAt, 'platform pool member');
    if (grant) this.assertTimeWindow(grant, lockedAt, 'platform pool grant');
    if (customerPrice) this.assertTimeWindow(customerPrice, lockedAt, 'customer price');
    if (supplierCost) this.assertTimeWindow(supplierCost, lockedAt, 'provider cost');
    if (input.expiresAt <= lockedAt.toISOString()) {
      fail('EXPIRED', 'prepared evidence is expired at the database clock');
    }
  }

  private assertMembershipWindows(
    rows: readonly EvidenceRow[],
    allowedRoles: ReadonlySet<string>,
    lockedAt: Date,
    label: string,
  ): void {
    const valid = rows.some(
      (row) =>
        String(row.status) === 'active' &&
        row.revoked_at == null &&
        typeof row.role === 'string' &&
        allowedRoles.has(row.role) &&
        this.isWithinWindow(row, lockedAt),
    );
    if (!valid) fail('AUTHORITY_MISMATCH', `${label} is expired, revoked, or not inference-capable`);
  }

  private assertTimeWindow(row: EvidenceRow, lockedAt: Date, label: string): void {
    if (!this.isWithinWindow(row, lockedAt)) fail('AUTHORITY_MISMATCH', `${label} is outside its validity window`);
  }

  private isWithinWindow(row: EvidenceRow, lockedAt: Date): boolean {
    const effectiveAt = rowDate(row, 'effective_at', 'authority effective_at');
    const expiresAt = rowDate(row, 'expires_at', 'authority expires_at');
    return (effectiveAt === null || effectiveAt <= lockedAt) && (expiresAt === null || expiresAt > lockedAt);
  }

  private assertAccount(row: EvidenceRow, input: NormalizedEvidence): void {
    if (
      row.status !== 'active' ||
      row.validation_state !== 'verified' ||
      String(row.authz_version) !== input.accountAuthzVersion ||
      String(row.provider_id) !== input.providerId ||
      String(row.product_id) !== input.productId
    ) {
      fail('AUTHORITY_MISMATCH', 'provider account authority does not match prepared evidence');
    }
  }

  private assertCredential(row: EvidenceRow, input: NormalizedEvidence): void {
    if (
      row.status !== 'active' ||
      row.validation_state !== 'verified' ||
      String(row.authz_version) !== input.credentialAuthzVersion ||
      String(row.current_version) !== input.credentialVersion
    ) {
      fail('AUTHORITY_MISMATCH', 'credential authority does not match prepared evidence');
    }
    const expiresAt = row.expires_at;
    if (expiresAt !== null && expiresAt !== undefined && !Number.isFinite(new Date(String(expiresAt)).getTime())) {
      fail('STORAGE_ERROR', 'credential expiry is invalid');
    }
  }

  private async audit(
    tx: SqlExecutor,
    input: NormalizedEvidence,
    action: string,
    targetId: string,
    occurredAt: string,
    override?: Required<PreparedRequestEvidenceAudit>,
  ): Promise<void> {
    const audit = override ?? input.audit;
    try {
      await tx.query(
        'INSERT INTO saas_audit_events ' +
          '(id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, ' +
          'source_ip, user_agent, entry_point, request_id) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          randomUUID(),
          input.tenantId,
          audit.actorUserId,
          action,
          'saas_prepared_request_evidence',
          targetId,
          occurredAt,
          audit.sourceIp,
          audit.userAgent,
          audit.entryPoint,
          audit.requestId,
        ],
      );
    } catch (error) {
      fail('AUDIT_FAILED', 'prepared evidence audit could not be written', error);
    }
  }

  private recordFromRow(
    row: EvidenceRow,
    input: NormalizedEvidence,
    statementSha256: string,
  ): PreparedRequestEvidenceRecord {
    const status = row.status === 'claimed' ? 'claimed' : 'registered';
    const claimedAt = row.claimed_at == null ? null : iso(row.claimed_at, 'claimed_at');
    const expiresAt = row.expires_at == null ? input.expiresAt : iso(row.expires_at, 'expires_at');
    return {
      evidenceId: stringValue(row, 'id', 'evidence id'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      attemptOrdinal: input.attemptOrdinal,
      supplyMode: input.supplyMode,
      accountOwnerKind: input.accountOwnerKind,
      publicModel: input.publicModel,
      protocol: input.protocol,
      ...(input.modelResolution === undefined ? {} : { requestedModel: input.modelResolution.requestedModel }),
      ...(input.modelResolution === undefined ? {} : { mappedModel: input.modelResolution.mappedModel }),
      resolvedModel: input.resolvedModel,
      ...(input.modelResolution === undefined ? {} : { modelResolution: input.modelResolution }),
      ...(input.clientProtocol === undefined ? {} : { clientProtocol: input.clientProtocol }),
      ...(input.providerProtocol === undefined ? {} : { providerProtocol: input.providerProtocol }),
      ...(input.clientOperation === undefined ? {} : { clientOperation: input.clientOperation }),
      ...(input.providerOperation === undefined ? {} : { providerOperation: input.providerOperation }),
      ...(input.requestFingerprint === undefined ? {} : { requestFingerprint: input.requestFingerprint }),
      ...(input.requestFingerprintVersion === undefined
        ? {}
        : { requestFingerprintVersion: input.requestFingerprintVersion }),
      ...(input.payloadCompilerVersion === undefined ? {} : { payloadCompilerVersion: input.payloadCompilerVersion }),
      ...(input.usageEstimatorVersion === undefined ? {} : { usageEstimatorVersion: input.usageEstimatorVersion }),
      endpoint: input.endpoint,
      upstreamId: input.upstreamId,
      accountId: input.accountId,
      credentialId: input.credentialId,
      credentialVersion: input.credentialVersion,
      routeTargetMode: input.routeTargetMode,
      payloadSha256: input.payloadSha256,
      statementSha256,
      status,
      claimedAt,
      claimedAttemptId: row.claimed_attempt_id == null ? null : String(row.claimed_attempt_id),
      expiresAt,
    };
  }

  private wrapStorage(error: unknown, message: string): SaasPreparedRequestEvidenceError {
    if (error instanceof SaasPreparedRequestEvidenceError) return error;
    return new SaasPreparedRequestEvidenceError('STORAGE_ERROR', message, { cause: error });
  }
}

function normalizedRowValue(row: EvidenceRow, key: string, label: string): unknown {
  if (!(key in row)) fail('STORAGE_ERROR', `${label} is missing from stored evidence`);
  return row[key];
}

function storedProvenanceValue(row: EvidenceRow, key: string, label: string): unknown {
  return normalizedRowValue(row, key, label);
}

function allNullish(values: readonly unknown[]): boolean {
  return values.every((value) => value === null || value === undefined);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null && value !== undefined);
}

function storedMappingVersion(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const normalized = integer(value, 'stored model resolution mapping version');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    fail('STORAGE_ERROR', 'stored model resolution mapping version exceeds the supported range');
  }
  return parsed;
}

function normalizeStoredEvidence(row: EvidenceRow, audit: Required<PreparedRequestEvidenceAudit>): NormalizedEvidence {
  const buckets = normalizedRowValue(row, 'usage_feasible_input_buckets', 'usage buckets');
  if (!Array.isArray(buckets)) fail('STORAGE_ERROR', 'stored usage buckets are invalid');
  const modelResolutionValues = [
    storedProvenanceValue(row, 'model_resolution_requested_model', 'requested model provenance'),
    storedProvenanceValue(row, 'model_resolution_mapped_model', 'mapped model provenance'),
    storedProvenanceValue(row, 'model_resolution_mapping_source', 'mapping source provenance'),
    storedProvenanceValue(row, 'model_resolution_mapping_version', 'mapping version provenance'),
  ];
  const modelResolutionAbsent = allNullish(modelResolutionValues.slice(0, 3)) && modelResolutionValues[3] == null;
  const modelResolutionComplete = allPresent(modelResolutionValues.slice(0, 3));
  if (!modelResolutionAbsent && !modelResolutionComplete) {
    fail('STORAGE_ERROR', 'stored model resolution provenance is incomplete');
  }

  const transportProvenanceValues = [
    storedProvenanceValue(row, 'provider_protocol', 'provider protocol provenance'),
    storedProvenanceValue(row, 'client_operation', 'client operation provenance'),
    storedProvenanceValue(row, 'provider_operation', 'provider operation provenance'),
  ];
  const compilerProvenanceValues = [
    storedProvenanceValue(row, 'request_fingerprint', 'request fingerprint provenance'),
    storedProvenanceValue(row, 'request_fingerprint_version', 'request fingerprint version provenance'),
    storedProvenanceValue(row, 'payload_compiler_version', 'payload compiler version provenance'),
    storedProvenanceValue(row, 'usage_estimator_version', 'usage estimator version provenance'),
  ];
  const transportProvenanceAbsent = allNullish(transportProvenanceValues);
  const compilerProvenanceAbsent = allNullish(compilerProvenanceValues);
  if (
    (!transportProvenanceAbsent && !allPresent(transportProvenanceValues)) ||
    (!compilerProvenanceAbsent && !allPresent(compilerProvenanceValues)) ||
    modelResolutionAbsent !== (transportProvenanceAbsent && compilerProvenanceAbsent)
  ) {
    fail('STORAGE_ERROR', 'stored model-resolution provenance snapshot is incomplete');
  }

  const publicModel = text(normalizedRowValue(row, 'public_model', 'public model'), 'publicModel');
  const resolvedModel = text(normalizedRowValue(row, 'resolved_model', 'resolved model'), 'resolvedModel');
  if (modelResolutionAbsent && publicModel !== resolvedModel) {
    fail('AUTHORITY_MISMATCH', 'legacy evidence without model provenance cannot bind a non-identity mapping');
  }
  const input: PreparedRequestEvidenceInput = {
    evidenceId: identifier(normalizedRowValue(row, 'id', 'evidence id'), 'evidenceId'),
    tenantId: identifier(normalizedRowValue(row, 'tenant_id', 'tenant id'), 'tenantId'),
    projectId: identifier(normalizedRowValue(row, 'project_id', 'project id'), 'projectId'),
    requestId: identifier(normalizedRowValue(row, 'request_id', 'request id'), 'requestId'),
    attemptId: identifier(normalizedRowValue(row, 'attempt_id', 'attempt id'), 'attemptId'),
    attemptOrdinal: Number(normalizedRowValue(row, 'attempt_ordinal', 'attempt ordinal')),
    proxyKeyId: identifier(normalizedRowValue(row, 'proxy_key_id', 'proxy key'), 'proxyKeyId'),
    entitlementId: identifier(normalizedRowValue(row, 'entitlement_id', 'entitlement'), 'entitlementId'),
    entitlementVersion: normalizedRowValue(
      row,
      'entitlement_version',
      'entitlement version',
    ) as PreparedEvidenceInteger,
    supplyProfileId: identifier(normalizedRowValue(row, 'supply_profile_id', 'profile'), 'supplyProfileId'),
    supplyProfileVersion: normalizedRowValue(
      row,
      'supply_profile_version',
      'profile version',
    ) as PreparedEvidenceInteger,
    modelScopeVersion: normalizedRowValue(row, 'model_scope_version', 'model scope version') as PreparedEvidenceInteger,
    supplyMode: String(normalizedRowValue(row, 'supply_mode', 'supply mode')) as PreparedEvidenceSupplyMode,
    principalKind: String(normalizedRowValue(row, 'principal_kind', 'principal kind')) as PreparedEvidencePrincipalKind,
    principalId: identifier(normalizedRowValue(row, 'principal_id', 'principal'), 'principalId'),
    authzVersion: normalizedRowValue(row, 'authz_version', 'authz version') as PreparedEvidenceInteger,
    configVersion: normalizedRowValue(row, 'config_version', 'config version') as PreparedEvidenceInteger,
    projectPolicyVersion: normalizedRowValue(
      row,
      'project_policy_version',
      'policy version',
    ) as PreparedEvidenceInteger,
    publicModel,
    protocol: String(normalizedRowValue(row, 'protocol', 'protocol')) as PreparedEvidenceProtocol,
    ...(modelResolutionAbsent
      ? {}
      : {
          modelResolution: {
            requestedModel: text(modelResolutionValues[0], 'stored requested model provenance'),
            mappedModel: text(modelResolutionValues[1], 'stored mapped model provenance'),
            resolvedModel,
            mappingSource: String(modelResolutionValues[2]) as ModelResolutionProvenance['mappingSource'],
            mappingVersion: storedMappingVersion(modelResolutionValues[3]),
          },
        }),
    ...(transportProvenanceAbsent
      ? {}
      : {
          providerProtocol: String(transportProvenanceValues[0]) as PreparedEvidenceProtocol,
          clientOperation: text(transportProvenanceValues[1], 'stored client operation provenance'),
          providerOperation: text(transportProvenanceValues[2], 'stored provider operation provenance'),
          requestFingerprint: String(compilerProvenanceValues[0]),
          requestFingerprintVersion: text(compilerProvenanceValues[1], 'stored request fingerprint version provenance'),
          payloadCompilerVersion: text(compilerProvenanceValues[2], 'stored payload compiler version provenance'),
          usageEstimatorVersion: text(compilerProvenanceValues[3], 'stored usage estimator version provenance'),
        }),
    endpoint: text(normalizedRowValue(row, 'endpoint', 'endpoint'), 'endpoint'),
    routeConfigId: identifier(normalizedRowValue(row, 'route_config_id', 'route'), 'routeConfigId'),
    routeConfigVersion: normalizedRowValue(row, 'route_config_version', 'route version') as PreparedEvidenceInteger,
    routePublicModelId: identifier(
      normalizedRowValue(row, 'route_public_model_id', 'route model'),
      'routePublicModelId',
    ),
    routePublicModelVersion: normalizedRowValue(
      row,
      'route_public_model_version',
      'route model version',
    ) as PreparedEvidenceInteger,
    routeProtocol: String(normalizedRowValue(row, 'route_protocol', 'route protocol')) as PreparedEvidenceProtocol,
    routeTargetMode: String(normalizedRowValue(row, 'route_target_mode', 'target mode')) as PreparedEvidenceTargetMode,
    routeUpstreamId: identifier(normalizedRowValue(row, 'route_upstream_id', 'route upstream'), 'routeUpstreamId'),
    upstreamId: identifier(normalizedRowValue(row, 'upstream_id', 'upstream'), 'upstreamId'),
    accountOwnerKind: String(normalizedRowValue(row, 'account_owner_kind', 'owner kind')) as PreparedEvidenceOwnerKind,
    accountId: identifier(normalizedRowValue(row, 'account_id', 'account'), 'accountId'),
    providerId: identifier(normalizedRowValue(row, 'provider_id', 'provider'), 'providerId'),
    productId: identifier(normalizedRowValue(row, 'product_id', 'product'), 'productId'),
    resolvedModel,
    dispatchProfileId: identifier(
      normalizedRowValue(row, 'dispatch_profile_id', 'dispatch profile'),
      'dispatchProfileId',
    ),
    supplyProfileAuthzVersion: normalizedRowValue(
      row,
      'supply_profile_authz_version',
      'profile epoch',
    ) as PreparedEvidenceInteger,
    credentialId: identifier(normalizedRowValue(row, 'credential_id', 'credential'), 'credentialId'),
    credentialVersion: normalizedRowValue(row, 'credential_version', 'credential version') as PreparedEvidenceInteger,
    credentialAuthzVersion: normalizedRowValue(
      row,
      'credential_authz_version',
      'credential epoch',
    ) as PreparedEvidenceInteger,
    accountAuthzVersion: normalizedRowValue(row, 'account_authz_version', 'account epoch') as PreparedEvidenceInteger,
    profileAccountAuthzVersion:
      row.profile_account_authz_version == null ? null : (row.profile_account_authz_version as PreparedEvidenceInteger),
    poolId: row.pool_id == null ? null : String(row.pool_id),
    poolAuthzVersion: row.pool_authz_version == null ? null : (row.pool_authz_version as PreparedEvidenceInteger),
    poolMemberAccountAuthzVersion:
      row.pool_member_account_authz_version == null
        ? null
        : (row.pool_member_account_authz_version as PreparedEvidenceInteger),
    poolMemberAuthzVersion:
      row.pool_member_authz_version == null ? null : (row.pool_member_authz_version as PreparedEvidenceInteger),
    poolGrantAuthzVersion:
      row.pool_grant_authz_version == null ? null : (row.pool_grant_authz_version as PreparedEvidenceInteger),
    poolGrantProfileAuthzVersion:
      row.pool_grant_profile_authz_version == null
        ? null
        : (row.pool_grant_profile_authz_version as PreparedEvidenceInteger),
    poolGrantPoolAuthzVersion:
      row.pool_grant_pool_authz_version == null ? null : (row.pool_grant_pool_authz_version as PreparedEvidenceInteger),
    customerMeteringPolicyId: identifier(
      normalizedRowValue(row, 'customer_metering_policy_id', 'customer policy'),
      'customerMeteringPolicyId',
    ),
    customerMeteringPolicyVersion: normalizedRowValue(
      row,
      'customer_metering_policy_version',
      'customer policy version',
    ) as PreparedEvidenceInteger,
    providerMeteringPolicyId: identifier(
      normalizedRowValue(row, 'provider_metering_policy_id', 'provider policy'),
      'providerMeteringPolicyId',
    ),
    providerMeteringPolicyVersion: normalizedRowValue(
      row,
      'provider_metering_policy_version',
      'provider policy version',
    ) as PreparedEvidenceInteger,
    contractAttestationId: identifier(
      normalizedRowValue(row, 'contract_attestation_id', 'attestation'),
      'contractAttestationId',
    ),
    customerPriceVersion: row.customer_price_version == null ? null : String(row.customer_price_version),
    supplierCostVersion: row.supplier_cost_version == null ? null : String(row.supplier_cost_version),
    payloadSha256: String(normalizedRowValue(row, 'payload_sha256', 'payload digest')),
    usage: {
      inputTotalUpperBound: normalizedRowValue(
        row,
        'usage_input_total_upper_bound',
        'input upper bound',
      ) as PreparedEvidenceInteger,
      inputUncachedUpperBound: normalizedRowValue(
        row,
        'usage_input_uncached_upper_bound',
        'uncached upper bound',
      ) as PreparedEvidenceInteger,
      cacheReadUpperBound: normalizedRowValue(
        row,
        'usage_cache_read_upper_bound',
        'cache-read upper bound',
      ) as PreparedEvidenceInteger,
      cacheWriteUpperBound: normalizedRowValue(
        row,
        'usage_cache_write_upper_bound',
        'cache-write upper bound',
      ) as PreparedEvidenceInteger,
      cacheWrite5mUpperBound: normalizedRowValue(
        row,
        'usage_cache_write_5m_upper_bound',
        'cache-write-5m upper bound',
      ) as PreparedEvidenceInteger,
      cacheWrite1hUpperBound: normalizedRowValue(
        row,
        'usage_cache_write_1h_upper_bound',
        'cache-write-1h upper bound',
      ) as PreparedEvidenceInteger,
      outputTotalUpperBound: normalizedRowValue(
        row,
        'usage_output_total_upper_bound',
        'output upper bound',
      ) as PreparedEvidenceInteger,
      reasoningOutputUpperBound: normalizedRowValue(
        row,
        'usage_reasoning_output_upper_bound',
        'reasoning upper bound',
      ) as PreparedEvidenceInteger,
      feasibleInputBuckets: buckets.map((value) => String(value)),
    },
    maxHoldCurrency: row.max_hold_currency == null ? null : String(row.max_hold_currency),
    maxHoldMinorUnits: normalizedRowValue(row, 'max_hold_minor_units', 'maximum hold') as PreparedEvidenceInteger,
    dispatchDeadline: String(normalizedRowValue(row, 'dispatch_deadline', 'dispatch deadline')),
    expiresAt: String(normalizedRowValue(row, 'expires_at', 'expiry')),
    retryBudget: Number(normalizedRowValue(row, 'retry_budget', 'retry budget')),
    verifierKeyId: text(normalizedRowValue(row, 'verifier_key_id', 'verifier key'), 'verifierKeyId'),
    signatureBase64: text(normalizedRowValue(row, 'signature_base64', 'signature'), 'signature'),
    audit,
  };
  return normalizeInput(input, true, modelResolutionAbsent);
}
