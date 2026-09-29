import { createPublicKey, type KeyObject, randomUUID, verify as verifySignature } from 'node:crypto';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type { GatewayProtocol, SaasRouteTargetMode, SupplyMode } from './contracts.js';

export type CommercialMeteringPolicyStatus = 'draft' | 'active' | 'disabled';
export type CommercialMeteringPolicyKind = 'customer' | 'provider';
export type CommercialMeteringPolicyVersionInput = bigint | number | string;
export type CommercialMeteringTokenSource = 'upstream' | 'local-estimate' | 'legacy';
export type CommercialMeteringDimension =
  | 'input_total'
  | 'input_uncached'
  | 'cache_read'
  | 'cache_write'
  | 'cache_write_5m'
  | 'cache_write_1h'
  | 'output_total'
  | 'reasoning_output';
export type CommercialMeteringRoundingMode = 'floor' | 'ceil' | 'half_up' | 'half_even';

export type TrustedVerifierPublicKey = KeyObject | string | Buffer;

export interface CommercialMeteringPolicyAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface CommercialMeteringPolicyDefinition {
  readonly publicModelId: string;
  readonly publicModelVersion: CommercialMeteringPolicyVersionInput;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly targetMode: SaasRouteTargetMode;
  readonly usageDimensions: readonly CommercialMeteringDimension[];
  readonly tokenSource: CommercialMeteringTokenSource;
  readonly roundingVersion: string;
  readonly roundingMode: CommercialMeteringRoundingMode;
  readonly roundingBoundary?: 'total';
  readonly commercialPolicyVersion: string;
}

export interface CustomerMeteringPolicyDefinition extends CommercialMeteringPolicyDefinition {
  readonly customerPriceVersion: string | null;
}

export interface ProviderMeteringPolicyDefinition extends CommercialMeteringPolicyDefinition {
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly supplierCostVersion: string | null;
}

export interface CreateCommercialMeteringPolicyInput<TDefinition> {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyId: string;
  readonly definition: TDefinition;
  readonly audit: CommercialMeteringPolicyAuditContext;
}

export interface PublishCommercialMeteringPolicyInput<TDefinition> {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyId: string;
  readonly expectedVersion: CommercialMeteringPolicyVersionInput;
  readonly definition?: TDefinition;
  readonly audit: CommercialMeteringPolicyAuditContext;
}

export interface DisableCommercialMeteringPolicyInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyId: string;
  readonly expectedVersion: CommercialMeteringPolicyVersionInput;
  readonly audit: CommercialMeteringPolicyAuditContext;
}

export interface CommercialMeteringPolicyRecord extends CommercialMeteringPolicyDefinition {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyId: string;
  readonly version: string;
  readonly status: CommercialMeteringPolicyStatus;
  readonly kind: CommercialMeteringPolicyKind;
  readonly customerPriceVersion: string | null;
  readonly providerId: string | null;
  readonly productId: string | null;
  readonly resolvedModel: string | null;
  readonly supplierCostVersion: string | null;
  readonly changedByUserId: string | null;
  readonly createdAt: string;
}

export interface ContractTestAttestationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: CommercialMeteringPolicyVersionInput;
  readonly publicModelId: string;
  readonly publicModelVersion: CommercialMeteringPolicyVersionInput;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly targetMode: SaasRouteTargetMode;
  readonly contractDigest: string;
  readonly suiteVersion: string;
  readonly testVectorDigest: string;
  readonly verifierKeyId: string;
  readonly signatureBase64: string;
  readonly usageDimensions: readonly CommercialMeteringDimension[];
  readonly tokenSource: CommercialMeteringTokenSource;
  readonly roundingVersion: string;
  readonly roundingMode: CommercialMeteringRoundingMode;
  readonly roundingBoundary?: 'total';
  readonly audit: CommercialMeteringPolicyAuditContext;
}

export interface ContractTestAttestationRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly targetMode: SaasRouteTargetMode;
  readonly contractDigest: string;
  readonly suiteVersion: string;
  readonly testVectorDigest: string;
  readonly verifierKeyId: string;
  readonly signatureBase64: string;
  readonly verificationResult: 'verified' | 'failed';
  readonly verifiedAt: string | null;
  readonly createdAt: string;
}

export interface BindRouteCommercialAuthorityInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly routeVersion: CommercialMeteringPolicyVersionInput;
  readonly customerPolicyId: string;
  readonly customerPolicyVersion: CommercialMeteringPolicyVersionInput;
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: CommercialMeteringPolicyVersionInput;
  readonly contractAttestationId: string;
  readonly audit: CommercialMeteringPolicyAuditContext;
}

export interface RouteCommercialAuthorityRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly routeVersion: string;
  readonly customerPolicyId: string;
  readonly customerPolicyVersion: string;
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: string;
  readonly contractAttestationId: string;
  readonly customerPriceVersion: string | null;
  readonly supplierCostVersion: string | null;
}

export interface ResolveCommercialMeteringAuthorityInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly supplyMode: SupplyMode;
  readonly executor?: SqlExecutor;
}

export interface CommercialMeteringPolicyServiceOptions {
  readonly now?: () => Date;
  readonly trustedVerifierPublicKeys?:
    | ReadonlyMap<string, TrustedVerifierPublicKey>
    | Readonly<Record<string, TrustedVerifierPublicKey>>;
  readonly trustedTestVectorDigests?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

export type CommercialMeteringPolicyErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CAS_CONFLICT'
  | 'INVALID_LIFECYCLE'
  | 'MISSING_AUTHORITY'
  | 'ATTESTATION_INVALID'
  | 'ATTESTATION_UNKNOWN_KEY'
  | 'ATTESTATION_BAD_SIGNATURE'
  | 'ATTESTATION_DIGEST_MISMATCH'
  | 'ATTESTATION_VECTOR_MISMATCH'
  | 'STORAGE_ERROR';

export class SaasCommercialMeteringPolicyError extends Error {
  constructor(
    readonly code: CommercialMeteringPolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasCommercialMeteringPolicyError';
  }
}

type Row = Record<string, unknown>;
const SHARED_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
const EXCLUSIVE_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
const PROVIDER_RIGHTS_FENCE_KEY = 'saas-authz:provider-rights';

type AdvisoryFenceMode = 'shared' | 'exclusive';

interface AdvisoryFenceRequest {
  readonly key: string;
  readonly mode: AdvisoryFenceMode;
}

async function lockAdvisoryFenceLayer(tx: SqlExecutor, requests: readonly AdvisoryFenceRequest[]): Promise<void> {
  const modes = new Map<string, AdvisoryFenceMode>();
  for (const request of requests) {
    const previous = modes.get(request.key);
    if (previous === 'exclusive' || previous === request.mode) continue;
    modes.set(request.key, request.mode === 'exclusive' ? 'exclusive' : (previous ?? request.mode));
  }
  for (const key of sortAndDedupeAdvisoryKeys([...modes.keys()])) {
    const mode = modes.get(key);
    await tx.query(mode === 'exclusive' ? EXCLUSIVE_ADVISORY_FENCE_SQL : SHARED_ADVISORY_FENCE_SQL, [key]);
  }
}

async function lockTenantProjectFences(
  tx: SqlExecutor,
  tenantId: string,
  projectId: string,
  mode: AdvisoryFenceMode,
): Promise<void> {
  await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.tenant(tenantId), mode }]);
  await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.project(tenantId, projectId), mode }]);
}

async function lockCommercialIdentityFences(
  tx: SqlExecutor,
  actorUserId: string | undefined,
  commercialKeys: readonly string[],
  mode: AdvisoryFenceMode,
): Promise<void> {
  await lockAdvisoryFenceLayer(tx, [
    ...(actorUserId === undefined ? [] : [{ key: saasAdvisoryKey.user(actorUserId), mode }]),
    ...commercialKeys.map((key) => ({ key, mode })),
    { key: PROVIDER_RIGHTS_FENCE_KEY, mode },
  ]);
}

async function lockCommercialScope(
  tx: SqlExecutor,
  tenantId: string,
  projectId: string,
  actorUserId: string | undefined,
  commercialKeys: readonly string[],
  mode: AdvisoryFenceMode,
): Promise<void> {
  await lockTenantProjectFences(tx, tenantId, projectId, mode);
  await lockCommercialIdentityFences(tx, actorUserId, commercialKeys, mode);
}

function commercialPolicyKey(
  kind: CommercialMeteringPolicyKind,
  tenantId: string,
  policyId: string,
  providerId?: string,
): string {
  if (kind === 'customer') return saasAdvisoryKey.commercialCustomer(tenantId, policyId);
  if (providerId === undefined) fail('STORAGE_ERROR', 'provider metering policy provider identity is missing');
  return saasAdvisoryKey.commercialProvider(providerId, policyId);
}

function commercialPolicyKeys(
  kind: CommercialMeteringPolicyKind,
  tenantId: string,
  policyId: string,
  providerIds: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      kind === 'customer'
        ? [commercialPolicyKey(kind, tenantId, policyId)]
        : providerIds.map((providerId) => commercialPolicyKey(kind, tenantId, policyId, providerId)),
    ),
  ];
}

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const PROTOCOLS = new Set<GatewayProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const SUPPLY_MODES = new Set<SupplyMode>(['byok', 'platform']);
const TARGET_MODES = new Set<SaasRouteTargetMode>(['tenant_account', 'platform_pool']);
const STATUSES = new Set<CommercialMeteringPolicyStatus>(['draft', 'active', 'disabled']);
const SOURCES = new Set<CommercialMeteringTokenSource>(['upstream', 'local-estimate', 'legacy']);
const DIMENSIONS = new Set<CommercialMeteringDimension>([
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output_total',
  'reasoning_output',
]);
const ROUNDING_MODES = new Set<CommercialMeteringRoundingMode>(['floor', 'ceil', 'half_up', 'half_even']);
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function fail(code: CommercialMeteringPolicyErrorCode, message: string, cause?: unknown): never {
  throw new SaasCommercialMeteringPolicyError(code, message, cause === undefined ? undefined : { cause });
}

function text(value: unknown, label: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim().length > max ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    fail('INVALID_INPUT', `${label} is invalid`);
  }
  return value.trim();
}

function version(value: unknown, label: string): string {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) parsed = BigInt(value.trim());
    else fail('INVALID_INPUT', `${label} must be a positive integer`);
  } catch (error) {
    if (error instanceof SaasCommercialMeteringPolicyError) throw error;
    fail('INVALID_INPUT', `${label} must be a positive integer`, error);
  }
  if (parsed < 1n || parsed > MAX_BIGINT) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed.toString(10);
}

function protocol(value: unknown): GatewayProtocol {
  if (typeof value !== 'string' || !PROTOCOLS.has(value as GatewayProtocol))
    fail('INVALID_INPUT', 'protocol is invalid');
  return value as GatewayProtocol;
}

function supplyMode(value: unknown): SupplyMode {
  if (typeof value !== 'string' || !SUPPLY_MODES.has(value as SupplyMode)) {
    fail('INVALID_INPUT', 'supplyMode is invalid');
  }
  return value as SupplyMode;
}

function targetMode(value: unknown): SaasRouteTargetMode {
  if (typeof value !== 'string' || !TARGET_MODES.has(value as SaasRouteTargetMode)) {
    fail('INVALID_INPUT', 'targetMode is invalid');
  }
  return value as SaasRouteTargetMode;
}

function status(value: unknown): CommercialMeteringPolicyStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as CommercialMeteringPolicyStatus)) {
    fail('STORAGE_ERROR', 'policy status is invalid');
  }
  return value as CommercialMeteringPolicyStatus;
}

function tokenSource(value: unknown): CommercialMeteringTokenSource {
  if (typeof value !== 'string' || !SOURCES.has(value as CommercialMeteringTokenSource)) {
    fail('INVALID_INPUT', 'tokenSource is invalid');
  }
  return value as CommercialMeteringTokenSource;
}

function roundingMode(value: unknown): CommercialMeteringRoundingMode {
  if (typeof value !== 'string' || !ROUNDING_MODES.has(value as CommercialMeteringRoundingMode)) {
    fail('INVALID_INPUT', 'roundingMode is invalid');
  }
  return value as CommercialMeteringRoundingMode;
}

function dimensions(value: unknown): readonly CommercialMeteringDimension[] {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_INPUT', 'usageDimensions are required');
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string' || !DIMENSIONS.has(entry as CommercialMeteringDimension)) {
      fail('INVALID_INPUT', 'usageDimensions contain an invalid dimension');
    }
    return entry as CommercialMeteringDimension;
  });
  if (new Set(normalized).size !== normalized.length) fail('INVALID_INPUT', 'usageDimensions contain duplicates');
  return normalized;
}

function normalizeDefinition<TDefinition extends CommercialMeteringPolicyDefinition>(input: TDefinition): TDefinition {
  const normalizedSupplyMode = supplyMode(input?.supplyMode);
  const normalizedTargetMode = targetMode(input?.targetMode);
  const expectedTargetMode: SaasRouteTargetMode = normalizedSupplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (normalizedTargetMode !== expectedTargetMode) fail('INVALID_INPUT', 'targetMode does not match supplyMode');
  return {
    ...input,
    publicModelId: text(input?.publicModelId, 'publicModelId'),
    publicModelVersion: version(input?.publicModelVersion, 'publicModelVersion'),
    protocol: protocol(input?.protocol),
    endpoint: text(input?.endpoint, 'endpoint', 1024),
    supplyMode: normalizedSupplyMode,
    targetMode: normalizedTargetMode,
    usageDimensions: dimensions(input?.usageDimensions),
    tokenSource: tokenSource(input?.tokenSource),
    roundingVersion: text(input?.roundingVersion, 'roundingVersion', 128),
    roundingMode: roundingMode(input?.roundingMode),
    roundingBoundary: 'total',
    commercialPolicyVersion: text(input?.commercialPolicyVersion, 'commercialPolicyVersion', 128),
  } as TDefinition;
}

function normalizeCustomerDefinition(input: CustomerMeteringPolicyDefinition): CustomerMeteringPolicyDefinition {
  const definition = normalizeDefinition(input);
  const price =
    definition.customerPriceVersion === null
      ? null
      : text(definition.customerPriceVersion, 'customerPriceVersion', 255);
  if ((definition.supplyMode === 'platform') !== (price !== null)) {
    fail('INVALID_INPUT', 'customerPriceVersion does not match supplyMode');
  }
  return { ...definition, customerPriceVersion: price };
}

function normalizeProviderDefinition(input: ProviderMeteringPolicyDefinition): ProviderMeteringPolicyDefinition {
  const definition = normalizeDefinition(input);
  const cost =
    definition.supplierCostVersion === null ? null : text(definition.supplierCostVersion, 'supplierCostVersion', 255);
  if ((definition.supplyMode === 'platform') !== (cost !== null)) {
    fail('INVALID_INPUT', 'supplierCostVersion does not match supplyMode');
  }
  return {
    ...definition,
    providerId: text(input.providerId, 'providerId', 255),
    productId: text(input.productId, 'productId', 255),
    resolvedModel: text(input.resolvedModel, 'resolvedModel', 512),
    supplierCostVersion: cost,
  };
}

function normalizeAudit(input: CommercialMeteringPolicyAuditContext): Required<CommercialMeteringPolicyAuditContext> {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', 'audit is required');
  const sourceIp = input.sourceIp ?? null;
  const userAgent = input.userAgent ?? null;
  const requestId = input.requestId ?? null;
  if (sourceIp !== null && typeof sourceIp !== 'string') fail('INVALID_INPUT', 'audit.sourceIp is invalid');
  if (userAgent !== null && typeof userAgent !== 'string') fail('INVALID_INPUT', 'audit.userAgent is invalid');
  if (requestId !== null && typeof requestId !== 'string') fail('INVALID_INPUT', 'audit.requestId is invalid');
  return {
    actorUserId: text(input.actorUserId, 'audit.actorUserId'),
    entryPoint: text(input.entryPoint, 'audit.entryPoint'),
    sourceIp,
    userAgent,
    requestId,
  };
}

function nowString(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT', 'clock is invalid');
  return value.toISOString();
}

function dateString(value: unknown, label: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  fail('STORAGE_ERROR', `${label} is invalid`);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) fail('STORAGE_ERROR', `${label} is invalid`);
  return value;
}

function mapPolicy(row: Row, kind: CommercialMeteringPolicyKind): CommercialMeteringPolicyRecord {
  const policySupplyMode = supplyMode(row.supply_mode);
  return {
    tenantId: text(row.tenant_id, 'tenant_id'),
    projectId: text(row.project_id, 'project_id'),
    policyId: text(row.policy_id, 'policy_id'),
    version: version(row.version, 'version'),
    status: status(row.status),
    kind,
    publicModelId: text(row.public_model_id, 'public_model_id'),
    publicModelVersion: version(row.public_model_version, 'public_model_version'),
    protocol: protocol(row.protocol),
    endpoint: text(row.endpoint, 'endpoint', 1024),
    supplyMode: policySupplyMode,
    targetMode: targetMode(row.target_mode),
    usageDimensions: dimensions(row.usage_dimensions),
    tokenSource: tokenSource(row.token_source),
    roundingVersion: text(row.rounding_version, 'rounding_version', 128),
    roundingMode: roundingMode(row.rounding_mode),
    roundingBoundary: 'total',
    commercialPolicyVersion: text(row.commercial_policy_version, 'commercial_policy_version', 128),
    customerPriceVersion:
      row.customer_price_version === null || row.customer_price_version === undefined
        ? null
        : text(row.customer_price_version, 'customer_price_version', 255),
    providerId:
      row.provider_id === null || row.provider_id === undefined ? null : text(row.provider_id, 'provider_id', 255),
    productId: row.product_id === null || row.product_id === undefined ? null : text(row.product_id, 'product_id', 255),
    resolvedModel:
      row.resolved_model === null || row.resolved_model === undefined
        ? null
        : text(row.resolved_model, 'resolved_model', 512),
    supplierCostVersion:
      row.supplier_cost_version === null || row.supplier_cost_version === undefined
        ? null
        : text(row.supplier_cost_version, 'supplier_cost_version', 255),
    changedByUserId:
      row.changed_by_user_id === null || row.changed_by_user_id === undefined
        ? null
        : text(row.changed_by_user_id, 'changed_by_user_id'),
    createdAt: dateString(row.created_at, 'created_at'),
  };
}

function mapAttestation(row: Row): ContractTestAttestationRecord {
  return {
    tenantId: text(row.tenant_id, 'tenant_id'),
    projectId: text(row.project_id, 'project_id'),
    id: text(row.id, 'id'),
    providerPolicyId: text(row.provider_policy_id, 'provider_policy_id'),
    providerPolicyVersion: version(row.provider_policy_version, 'provider_policy_version'),
    publicModelId: text(row.public_model_id, 'public_model_id'),
    publicModelVersion: version(row.public_model_version, 'public_model_version'),
    protocol: protocol(row.protocol),
    endpoint: text(row.endpoint, 'endpoint', 1024),
    supplyMode: supplyMode(row.supply_mode),
    targetMode: targetMode(row.target_mode),
    contractDigest: digest(row.contract_digest, 'contract_digest'),
    suiteVersion: text(row.suite_version, 'suite_version', 128),
    testVectorDigest: digest(row.test_vector_digest, 'test_vector_digest'),
    verifierKeyId: text(row.verifier_key_id, 'verifier_key_id', 255),
    signatureBase64: text(row.signature_base64, 'signature_base64', 8192),
    verificationResult:
      row.verification_result === 'verified' || row.verification_result === 'failed'
        ? row.verification_result
        : fail('STORAGE_ERROR', 'verification result is invalid'),
    verifiedAt:
      row.verified_at === null || row.verified_at === undefined ? null : dateString(row.verified_at, 'verified_at'),
    createdAt: dateString(row.created_at, 'created_at'),
  };
}

function keyValue<T>(source: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined, key: string): T | null {
  if (!source) return null;
  if (source instanceof Map) return source.get(key) ?? null;
  const record = source as Readonly<Record<string, T>>;
  return Object.hasOwn(record, key) ? (record[key] ?? null) : null;
}

export interface ContractAttestationPayload {
  readonly contractDigest: string;
  readonly suiteVersion: string;
  readonly testVectorDigest: string;
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly targetMode: SaasRouteTargetMode;
  readonly usageDimensions: readonly CommercialMeteringDimension[];
  readonly tokenSource: CommercialMeteringTokenSource;
  readonly roundingVersion: string;
  readonly roundingMode: CommercialMeteringRoundingMode;
  readonly roundingBoundary: 'total';
}

/** Canonical bytes signed by a trusted contract-test verifier. */
export function canonicalContractAttestationPayload(payload: ContractAttestationPayload): string {
  return JSON.stringify({
    contractDigest: payload.contractDigest,
    suiteVersion: payload.suiteVersion,
    testVectorDigest: payload.testVectorDigest,
    providerPolicyId: payload.providerPolicyId,
    providerPolicyVersion: payload.providerPolicyVersion,
    publicModelId: payload.publicModelId,
    publicModelVersion: payload.publicModelVersion,
    protocol: payload.protocol,
    endpoint: payload.endpoint,
    supplyMode: payload.supplyMode,
    targetMode: payload.targetMode,
    usageDimensions: [...payload.usageDimensions],
    tokenSource: payload.tokenSource,
    roundingVersion: payload.roundingVersion,
    roundingMode: payload.roundingMode,
    roundingBoundary: payload.roundingBoundary,
  });
}

function attestationPayloadFromInput(
  input: ContractTestAttestationInput,
  providerPolicyVersion: string,
): ContractAttestationPayload {
  return {
    contractDigest: input.contractDigest,
    suiteVersion: input.suiteVersion,
    testVectorDigest: input.testVectorDigest,
    providerPolicyId: input.providerPolicyId,
    providerPolicyVersion,
    publicModelId: input.publicModelId,
    publicModelVersion: version(input.publicModelVersion, 'publicModelVersion'),
    protocol: input.protocol,
    endpoint: input.endpoint,
    supplyMode: input.supplyMode,
    targetMode: input.targetMode,
    usageDimensions: input.usageDimensions,
    tokenSource: input.tokenSource,
    roundingVersion: input.roundingVersion,
    roundingMode: input.roundingMode,
    roundingBoundary: 'total',
  };
}

interface PolicyHeadRow extends Row {
  tenant_id: unknown;
  project_id: unknown;
  policy_id: unknown;
  current_version: unknown;
  status: unknown;
}

function auditSql(
  tx: SqlExecutor,
  tenantId: string,
  audit: Required<CommercialMeteringPolicyAuditContext>,
  action: string,
  targetId: string,
  now: string,
): Promise<unknown> {
  return tx.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
        source_ip, user_agent, entry_point, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      tenantId,
      audit.actorUserId,
      action,
      'saas_commercial_metering_authority',
      targetId,
      now,
      audit.sourceIp,
      audit.userAgent,
      audit.entryPoint,
      audit.requestId,
    ],
  );
}

function policyInsertColumns(kind: CommercialMeteringPolicyKind): string {
  if (kind === 'customer') {
    return `tenant_id, project_id, policy_id, version, status, public_model_id, public_model_version,
      protocol, endpoint, supply_mode, target_mode, customer_price_version, usage_dimensions,
      token_source, rounding_version, rounding_mode, rounding_boundary, commercial_policy_version,
      changed_by_user_id, created_at`;
  }
  return `tenant_id, project_id, policy_id, version, status, public_model_id, public_model_version,
    protocol, endpoint, supply_mode, target_mode, provider_id, product_id, resolved_model,
    supplier_cost_version, usage_dimensions, token_source, rounding_version, rounding_mode,
    rounding_boundary, commercial_policy_version, changed_by_user_id, created_at`;
}

function policyInsertValues(
  tenantId: string,
  projectId: string,
  policyId: string,
  definition: CustomerMeteringPolicyDefinition | ProviderMeteringPolicyDefinition,
  versionValue: string,
  statusValue: CommercialMeteringPolicyStatus,
  actorUserId: string,
  now: string,
): readonly unknown[] {
  const provider = 'providerId' in definition ? definition : null;
  if (!provider) {
    return [
      tenantId,
      projectId,
      policyId,
      versionValue,
      statusValue,
      definition.publicModelId,
      definition.publicModelVersion,
      definition.protocol,
      definition.endpoint,
      definition.supplyMode,
      definition.targetMode,
      'customerPriceVersion' in definition ? definition.customerPriceVersion : null,
      [...definition.usageDimensions],
      definition.tokenSource,
      definition.roundingVersion,
      definition.roundingMode,
      'total',
      definition.commercialPolicyVersion,
      actorUserId,
      now,
    ];
  }
  const providerDefinition = definition as ProviderMeteringPolicyDefinition;
  return [
    tenantId,
    projectId,
    policyId,
    versionValue,
    statusValue,
    definition.publicModelId,
    definition.publicModelVersion,
    definition.protocol,
    definition.endpoint,
    definition.supplyMode,
    definition.targetMode,
    providerDefinition.providerId,
    providerDefinition.productId,
    providerDefinition.resolvedModel,
    providerDefinition.supplierCostVersion,
    [...definition.usageDimensions],
    definition.tokenSource,
    definition.roundingVersion,
    definition.roundingMode,
    'total',
    definition.commercialPolicyVersion,
    actorUserId,
    now,
  ];
}

function policyRecordFromDefinition(
  tenantId: string,
  projectId: string,
  policyId: string,
  definition: CustomerMeteringPolicyDefinition | ProviderMeteringPolicyDefinition,
  versionValue: string,
  statusValue: CommercialMeteringPolicyStatus,
  actorUserId: string,
  now: string,
): CommercialMeteringPolicyRecord {
  const provider = 'providerId' in definition ? definition : null;
  return {
    ...definition,
    publicModelVersion: versionValueOf(definition.publicModelVersion),
    version: versionValue,
    tenantId,
    projectId,
    policyId,
    status: statusValue,
    kind: provider ? 'provider' : 'customer',
    customerPriceVersion: 'customerPriceVersion' in definition ? definition.customerPriceVersion : null,
    providerId: provider?.providerId ?? null,
    productId: provider?.productId ?? null,
    resolvedModel: provider?.resolvedModel ?? null,
    supplierCostVersion: provider?.supplierCostVersion ?? null,
    changedByUserId: actorUserId,
    createdAt: now,
  };
}

function versionValueOf(value: unknown): string {
  return typeof value === 'string' ? value : version(value, 'publicModelVersion');
}

function rowDefinition(
  row: Row,
  kind: CommercialMeteringPolicyKind,
): CustomerMeteringPolicyDefinition | ProviderMeteringPolicyDefinition {
  const base = {
    publicModelId: text(row.public_model_id, 'public_model_id'),
    publicModelVersion: version(row.public_model_version, 'public_model_version'),
    protocol: protocol(row.protocol),
    endpoint: text(row.endpoint, 'endpoint', 1024),
    supplyMode: supplyMode(row.supply_mode),
    targetMode: targetMode(row.target_mode),
    usageDimensions: dimensions(row.usage_dimensions),
    tokenSource: tokenSource(row.token_source),
    roundingVersion: text(row.rounding_version, 'rounding_version', 128),
    roundingMode: roundingMode(row.rounding_mode),
    roundingBoundary: 'total' as const,
    commercialPolicyVersion: text(row.commercial_policy_version, 'commercial_policy_version', 128),
  };
  if (kind === 'customer') {
    return {
      ...base,
      customerPriceVersion:
        row.customer_price_version === null || row.customer_price_version === undefined
          ? null
          : text(row.customer_price_version, 'customer_price_version', 255),
    };
  }
  return {
    ...base,
    providerId: text(row.provider_id, 'provider_id', 255),
    productId: text(row.product_id, 'product_id', 255),
    resolvedModel: text(row.resolved_model, 'resolved_model', 512),
    supplierCostVersion:
      row.supplier_cost_version === null || row.supplier_cost_version === undefined
        ? null
        : text(row.supplier_cost_version, 'supplier_cost_version', 255),
  };
}

export class SaasCommercialMeteringPolicyService {
  constructor(
    private readonly database: SaasDatabase,
    private readonly options: CommercialMeteringPolicyServiceOptions = {},
  ) {}

  async createCustomerPolicy(
    input: CreateCommercialMeteringPolicyInput<CustomerMeteringPolicyDefinition>,
  ): Promise<CommercialMeteringPolicyRecord> {
    return this.createPolicy(input, 'customer');
  }

  async createProviderPolicy(
    input: CreateCommercialMeteringPolicyInput<ProviderMeteringPolicyDefinition>,
  ): Promise<CommercialMeteringPolicyRecord> {
    return this.createPolicy(input, 'provider');
  }

  async publishCustomerPolicy(
    input: PublishCommercialMeteringPolicyInput<CustomerMeteringPolicyDefinition>,
  ): Promise<CommercialMeteringPolicyRecord> {
    return this.publishPolicy(input, 'customer');
  }

  async publishProviderPolicy(
    input: PublishCommercialMeteringPolicyInput<ProviderMeteringPolicyDefinition>,
  ): Promise<CommercialMeteringPolicyRecord> {
    return this.publishPolicy(input, 'provider');
  }

  async disableCustomerPolicy(input: DisableCommercialMeteringPolicyInput): Promise<CommercialMeteringPolicyRecord> {
    return this.setPolicyStatus(input, 'customer', 'disabled');
  }

  async disableProviderPolicy(input: DisableCommercialMeteringPolicyInput): Promise<CommercialMeteringPolicyRecord> {
    return this.setPolicyStatus(input, 'provider', 'disabled');
  }

  async attestProviderContract(input: ContractTestAttestationInput): Promise<ContractTestAttestationRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const id = text(input?.id, 'id', 255);
    const providerPolicyId = text(input?.providerPolicyId, 'providerPolicyId', 255);
    const providerPolicyVersion = version(input?.providerPolicyVersion, 'providerPolicyVersion');
    const normalizedInput: ContractTestAttestationInput = {
      ...input,
      tenantId,
      projectId,
      id,
      providerPolicyId,
      providerPolicyVersion,
      publicModelId: text(input?.publicModelId, 'publicModelId'),
      publicModelVersion: version(input?.publicModelVersion, 'publicModelVersion'),
      protocol: protocol(input?.protocol),
      endpoint: text(input?.endpoint, 'endpoint', 1024),
      supplyMode: supplyMode(input?.supplyMode),
      targetMode: targetMode(input?.targetMode),
      contractDigest: digest(input?.contractDigest, 'contractDigest'),
      suiteVersion: text(input?.suiteVersion, 'suiteVersion', 128),
      testVectorDigest: digest(input?.testVectorDigest, 'testVectorDigest'),
      verifierKeyId: text(input?.verifierKeyId, 'verifierKeyId', 255),
      signatureBase64: text(input?.signatureBase64, 'signatureBase64', 8192),
      usageDimensions: dimensions(input?.usageDimensions),
      tokenSource: tokenSource(input?.tokenSource),
      roundingVersion: text(input?.roundingVersion, 'roundingVersion', 128),
      roundingMode: roundingMode(input?.roundingMode),
      roundingBoundary: 'total',
      audit: normalizeAudit(input?.audit),
    };
    const normalizedAudit = normalizeAudit(input?.audit);
    const now = nowString(this.options.now ?? (() => new Date()));
    try {
      return await this.database.transaction(async (tx) => {
        await lockTenantProjectFences(tx, tenantId, projectId, 'exclusive');
        const providerPolicyHint = await this.getPolicyRow(
          tx,
          tenantId,
          projectId,
          providerPolicyId,
          providerPolicyVersion,
          'provider',
        );
        if (!providerPolicyHint) fail('NOT_FOUND', 'provider metering policy was not found');
        const providerId = text(providerPolicyHint.provider_id, 'provider_id', 255);
        await lockCommercialIdentityFences(
          tx,
          normalizedAudit.actorUserId,
          [commercialPolicyKey('provider', tenantId, providerPolicyId, providerId)],
          'exclusive',
        );
        const providerPolicy = await this.getPolicyRow(
          tx,
          tenantId,
          projectId,
          providerPolicyId,
          providerPolicyVersion,
          'provider',
        );
        if (!providerPolicy) fail('NOT_FOUND', 'provider metering policy was not found');
        const definition = rowDefinition(providerPolicy, 'provider') as ProviderMeteringPolicyDefinition;
        this.assertAttestationMatchesPolicy(normalizedInput, definition, providerPolicyVersion);
        this.verifyAttestation(normalizedInput, providerPolicyVersion);
        const rows = await tx.query<Row>(
          `INSERT INTO saas_contract_test_attestations
             (tenant_id, project_id, id, provider_policy_id, provider_policy_version,
              public_model_id, public_model_version, protocol, endpoint, supply_mode, target_mode,
              contract_digest, suite_version, test_vector_digest, verifier_key_id, signature_base64,
              verification_result, verified_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   'verified', $17, $17)
           RETURNING tenant_id, project_id, id, provider_policy_id, provider_policy_version,
                     public_model_id, public_model_version, protocol, endpoint, supply_mode, target_mode,
                     contract_digest, suite_version, test_vector_digest, verifier_key_id, signature_base64,
                     verification_result, verified_at, created_at`,
          [
            tenantId,
            projectId,
            id,
            providerPolicyId,
            providerPolicyVersion,
            normalizedInput.publicModelId,
            normalizedInput.publicModelVersion,
            normalizedInput.protocol,
            normalizedInput.endpoint,
            normalizedInput.supplyMode,
            normalizedInput.targetMode,
            normalizedInput.contractDigest,
            normalizedInput.suiteVersion,
            normalizedInput.testVectorDigest,
            normalizedInput.verifierKeyId,
            normalizedInput.signatureBase64,
            now,
          ],
        );
        const row = rows.rows[0];
        if (!row) fail('STORAGE_ERROR', 'attestation insert returned no row');
        await auditSql(
          tx,
          tenantId,
          normalizedAudit,
          'commercial_metering.attestation_verified',
          `${projectId}:${id}`,
          now,
        );
        return mapAttestation(row);
      });
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', 'contract attestation could not be stored', error);
    }
  }

  async bindRoute(input: BindRouteCommercialAuthorityInput): Promise<RouteCommercialAuthorityRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const routeId = text(input?.routeId, 'routeId');
    const routeVersion = version(input?.routeVersion, 'routeVersion');
    const customerPolicyId = text(input?.customerPolicyId, 'customerPolicyId');
    const customerPolicyVersion = version(input?.customerPolicyVersion, 'customerPolicyVersion');
    const providerPolicyId = text(input?.providerPolicyId, 'providerPolicyId');
    const providerPolicyVersion = version(input?.providerPolicyVersion, 'providerPolicyVersion');
    const contractAttestationId = text(input?.contractAttestationId, 'contractAttestationId');
    const audit = normalizeAudit(input?.audit);
    const now = nowString(this.options.now ?? (() => new Date()));
    try {
      return await this.database.transaction(async (tx) => {
        await lockTenantProjectFences(tx, tenantId, projectId, 'exclusive');
        const providerPolicyHint = await this.getPolicyRow(
          tx,
          tenantId,
          projectId,
          providerPolicyId,
          providerPolicyVersion,
          'provider',
        );
        if (!providerPolicyHint) fail('MISSING_AUTHORITY', 'provider metering policy is missing');
        const providerId = text(providerPolicyHint.provider_id, 'provider_id', 255);
        await lockCommercialIdentityFences(
          tx,
          audit.actorUserId,
          [
            commercialPolicyKey('customer', tenantId, customerPolicyId),
            commercialPolicyKey('provider', tenantId, providerPolicyId, providerId),
          ],
          'exclusive',
        );
        const route = await tx.query<Row>(
          `SELECT rv.tenant_id, rv.project_id, rv.route_id, rv.version, rv.status,
                  rv.public_model_id, rv.public_model_version, rv.protocol, rv.endpoint,
                  rv.supply_mode, rv.target_mode, h.current_version, h.status AS head_status
           FROM saas_route_config_versions rv
           JOIN saas_route_config_heads h
             ON h.tenant_id = rv.tenant_id AND h.project_id = rv.project_id AND h.route_id = rv.route_id
           WHERE rv.tenant_id = $1 AND rv.project_id = $2 AND rv.route_id = $3 AND rv.version = $4
           LIMIT 2`,
          [tenantId, projectId, routeId, routeVersion],
        );
        if (route.rows.length === 0) fail('NOT_FOUND', 'route version was not found');
        if (route.rows.length !== 1) fail('STORAGE_ERROR', 'route version is ambiguous');
        const routeRow = route.rows[0];
        if (
          routeRow?.status !== 'active' ||
          routeRow.status !== 'active' ||
          routeRow.head_status !== 'active' ||
          String(routeRow.current_version) !== routeVersion
        ) {
          fail('MISSING_AUTHORITY', 'route version is not the active route head');
        }

        const customerPolicy = await this.getPolicyRow(
          tx,
          tenantId,
          projectId,
          customerPolicyId,
          customerPolicyVersion,
          'customer',
        );
        const providerPolicy = await this.getPolicyRow(
          tx,
          tenantId,
          projectId,
          providerPolicyId,
          providerPolicyVersion,
          'provider',
        );
        if (!customerPolicy || !providerPolicy) fail('MISSING_AUTHORITY', 'commercial metering policy is missing');
        if (customerPolicy.status !== 'active' || providerPolicy.status !== 'active') {
          fail('MISSING_AUTHORITY', 'commercial metering policy is not active');
        }
        const customer = mapPolicy(customerPolicy, 'customer');
        const provider = mapPolicy(providerPolicy, 'provider');
        if (
          customer.publicModelId !== text(routeRow.public_model_id, 'route.public_model_id') ||
          customer.publicModelVersion !== version(routeRow.public_model_version, 'route.public_model_version') ||
          customer.protocol !== protocol(routeRow.protocol) ||
          customer.endpoint !== text(routeRow.endpoint, 'route.endpoint', 1024) ||
          customer.supplyMode !== supplyMode(routeRow.supply_mode) ||
          customer.targetMode !== targetMode(routeRow.target_mode) ||
          provider.publicModelId !== customer.publicModelId ||
          provider.publicModelVersion !== customer.publicModelVersion ||
          provider.protocol !== customer.protocol ||
          provider.endpoint !== customer.endpoint ||
          provider.supplyMode !== customer.supplyMode ||
          provider.targetMode !== customer.targetMode
        ) {
          fail('MISSING_AUTHORITY', 'commercial policy identity does not match route');
        }

        const attestationResult = await tx.query<Row>(
          `SELECT tenant_id, project_id, id, provider_policy_id, provider_policy_version,
                  public_model_id, public_model_version, protocol, endpoint, supply_mode, target_mode,
                  contract_digest, suite_version, test_vector_digest, verifier_key_id, signature_base64,
                  verification_result, verified_at, created_at
           FROM saas_contract_test_attestations
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           LIMIT 2`,
          [tenantId, projectId, contractAttestationId],
        );
        if (attestationResult.rows.length !== 1 || !attestationResult.rows[0]) {
          fail('MISSING_AUTHORITY', 'contract attestation is missing or ambiguous');
        }
        const attestation = mapAttestation(attestationResult.rows[0]);
        if (attestation.verificationResult !== 'verified')
          fail('MISSING_AUTHORITY', 'contract attestation is not verified');
        const attestationInput: ContractTestAttestationInput = {
          tenantId,
          projectId,
          id: attestation.id,
          providerPolicyId: attestation.providerPolicyId,
          providerPolicyVersion: attestation.providerPolicyVersion,
          publicModelId: attestation.publicModelId,
          publicModelVersion: attestation.publicModelVersion,
          protocol: attestation.protocol,
          endpoint: attestation.endpoint,
          supplyMode: attestation.supplyMode,
          targetMode: attestation.targetMode,
          contractDigest: attestation.contractDigest,
          suiteVersion: attestation.suiteVersion,
          testVectorDigest: attestation.testVectorDigest,
          verifierKeyId: attestation.verifierKeyId,
          signatureBase64: attestation.signatureBase64,
          usageDimensions: provider.usageDimensions,
          tokenSource: provider.tokenSource,
          roundingVersion: provider.roundingVersion,
          roundingMode: provider.roundingMode,
          roundingBoundary: 'total',
          audit,
        };
        this.assertAttestationMatchesPolicy(
          attestationInput,
          provider as ProviderMeteringPolicyDefinition,
          providerPolicyVersion,
        );
        this.verifyAttestation(attestationInput, providerPolicyVersion);

        const inserted = await tx.query<Row>(
          `INSERT INTO saas_route_config_commercial_authorities
             (tenant_id, project_id, route_id, route_version,
              customer_policy_id, customer_policy_version, provider_policy_id, provider_policy_version,
              contract_attestation_id, customer_price_version, supplier_cost_version,
              created_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING tenant_id, project_id, route_id, route_version,
                     customer_policy_id, customer_policy_version, provider_policy_id, provider_policy_version,
                     contract_attestation_id, customer_price_version, supplier_cost_version`,
          [
            tenantId,
            projectId,
            routeId,
            routeVersion,
            customerPolicyId,
            customerPolicyVersion,
            providerPolicyId,
            providerPolicyVersion,
            contractAttestationId,
            customer.customerPriceVersion,
            provider.supplierCostVersion,
            audit.actorUserId,
            now,
          ],
        );
        await auditSql(
          tx,
          tenantId,
          audit,
          'commercial_metering.route_authority_bound',
          `${projectId}:${routeId}:${routeVersion}`,
          now,
        );
        const row = inserted.rows[0] ?? {
          tenant_id: tenantId,
          project_id: projectId,
          route_id: routeId,
          route_version: routeVersion,
          customer_policy_id: customerPolicyId,
          customer_policy_version: customerPolicyVersion,
          provider_policy_id: providerPolicyId,
          provider_policy_version: providerPolicyVersion,
          contract_attestation_id: contractAttestationId,
          customer_price_version: customer.customerPriceVersion,
          supplier_cost_version: provider.supplierCostVersion,
        };
        return {
          tenantId: text(row.tenant_id, 'tenant_id'),
          projectId: text(row.project_id, 'project_id'),
          routeId: text(row.route_id, 'route_id'),
          routeVersion: version(row.route_version, 'route_version'),
          customerPolicyId: text(row.customer_policy_id, 'customer_policy_id'),
          customerPolicyVersion: version(row.customer_policy_version, 'customer_policy_version'),
          providerPolicyId: text(row.provider_policy_id, 'provider_policy_id'),
          providerPolicyVersion: version(row.provider_policy_version, 'provider_policy_version'),
          contractAttestationId: text(row.contract_attestation_id, 'contract_attestation_id'),
          customerPriceVersion:
            row.customer_price_version === null || row.customer_price_version === undefined
              ? null
              : text(row.customer_price_version, 'customer_price_version'),
          supplierCostVersion:
            row.supplier_cost_version === null || row.supplier_cost_version === undefined
              ? null
              : text(row.supplier_cost_version, 'supplier_cost_version'),
        };
      });
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', 'route commercial authority could not be bound', error);
    }
  }

  async resolveDispatchableRoute(
    tenantIdInput: string,
    projectIdInput: string,
    routeIdInput: string,
    routeVersionInput: CommercialMeteringPolicyVersionInput,
    executor?: SqlExecutor,
  ): Promise<RouteCommercialAuthorityRecord | null> {
    const tenantId = text(tenantIdInput, 'tenantId');
    const projectId = text(projectIdInput, 'projectId');
    const routeId = text(routeIdInput, 'routeId');
    const routeVersion = version(routeVersionInput, 'routeVersion');
    const run = async (tx: SqlExecutor): Promise<RouteCommercialAuthorityRecord | null> => {
      await lockTenantProjectFences(tx, tenantId, projectId, 'shared');
      const selectSql = `SELECT tenant_id, project_id, route_id, version,
                                customer_policy_id, customer_policy_version, provider_policy_id, provider_policy_version,
                                contract_attestation_id, customer_price_version, supplier_cost_version
                         FROM saas_route_config_dispatchable
                         WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3 AND version = $4
                         LIMIT 2`;
      let result = await tx.query<Row>(selectSql, [tenantId, projectId, routeId, routeVersion]);
      if (result.rows.length > 1) fail('STORAGE_ERROR', 'dispatchable route authority is ambiguous');
      const hint = result.rows[0];
      if (!hint) return null;
      const customerPolicyId = text(hint.customer_policy_id, 'customer_policy_id', 255);
      const providerPolicyId = text(hint.provider_policy_id, 'provider_policy_id', 255);
      const providerPolicyVersion = version(hint.provider_policy_version, 'provider_policy_version');
      const providerPolicy = await this.getPolicyRow(
        tx,
        tenantId,
        projectId,
        providerPolicyId,
        providerPolicyVersion,
        'provider',
      );
      if (!providerPolicy) return null;
      const providerId = text(providerPolicy.provider_id, 'provider_id', 255);
      await lockCommercialIdentityFences(
        tx,
        undefined,
        [
          commercialPolicyKey('customer', tenantId, customerPolicyId),
          commercialPolicyKey('provider', tenantId, providerPolicyId, providerId),
        ],
        'shared',
      );
      result = await tx.query<Row>(selectSql, [tenantId, projectId, routeId, routeVersion]);
      if (result.rows.length > 1) fail('STORAGE_ERROR', 'dispatchable route authority is ambiguous');
      const row = result.rows[0];
      if (!row) return null;
      return {
        tenantId: text(row.tenant_id, 'tenant_id'),
        projectId: text(row.project_id, 'project_id'),
        routeId: text(row.route_id, 'route_id'),
        routeVersion: version(row.version, 'version'),
        customerPolicyId: text(row.customer_policy_id, 'customer_policy_id'),
        customerPolicyVersion: version(row.customer_policy_version, 'customer_policy_version'),
        providerPolicyId: text(row.provider_policy_id, 'provider_policy_id'),
        providerPolicyVersion: version(row.provider_policy_version, 'provider_policy_version'),
        contractAttestationId: text(row.contract_attestation_id, 'contract_attestation_id'),
        customerPriceVersion:
          row.customer_price_version === null || row.customer_price_version === undefined
            ? null
            : text(row.customer_price_version, 'customer_price_version'),
        supplierCostVersion:
          row.supplier_cost_version === null || row.supplier_cost_version === undefined
            ? null
            : text(row.supplier_cost_version, 'supplier_cost_version'),
      };
    };
    try {
      return executor ? await run(executor) : await this.database.transaction(run);
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', 'dispatchable route authority could not be read', error);
    }
  }

  /** Resolve only a currently dispatchable route by the public request identity. */
  async resolveForRequest(
    input: ResolveCommercialMeteringAuthorityInput,
  ): Promise<RouteCommercialAuthorityRecord | null> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const publicModel = text(input?.publicModel, 'publicModel', 512);
    const requestedProtocol = protocol(input?.protocol);
    const requestedSupplyMode = supplyMode(input?.supplyMode);
    const run = async (tx: SqlExecutor): Promise<RouteCommercialAuthorityRecord | null> => {
      await lockTenantProjectFences(tx, tenantId, projectId, 'shared');
      const selectSql = `SELECT d.tenant_id, d.project_id, d.route_id, d.version,
                                d.customer_policy_id, d.customer_policy_version, d.provider_policy_id,
                                d.provider_policy_version, d.contract_attestation_id,
                                d.customer_price_version, d.supplier_cost_version
                         FROM saas_route_config_dispatchable d
                         JOIN saas_public_model_versions pmv
                           ON pmv.public_model_id = d.public_model_id
                          AND pmv.version = d.public_model_version
                         JOIN saas_public_models pm ON pm.id = pmv.public_model_id
                         WHERE d.tenant_id = $1 AND d.project_id = $2
                           AND pm.alias = $3 AND d.protocol = $4 AND d.supply_mode = $5
                         LIMIT 2`;
      const values = [tenantId, projectId, publicModel, requestedProtocol, requestedSupplyMode];
      let result = await tx.query<Row>(selectSql, values);
      if (result.rows.length > 1) fail('STORAGE_ERROR', 'dispatchable route authority is ambiguous');
      const hint = result.rows[0];
      if (!hint) return null;
      const customerPolicyId = text(hint.customer_policy_id, 'customer_policy_id', 255);
      const providerPolicyId = text(hint.provider_policy_id, 'provider_policy_id', 255);
      const providerPolicyVersion = version(hint.provider_policy_version, 'provider_policy_version');
      const providerPolicy = await this.getPolicyRow(
        tx,
        tenantId,
        projectId,
        providerPolicyId,
        providerPolicyVersion,
        'provider',
      );
      if (!providerPolicy) return null;
      const providerId = text(providerPolicy.provider_id, 'provider_id', 255);
      await lockCommercialIdentityFences(
        tx,
        undefined,
        [
          commercialPolicyKey('customer', tenantId, customerPolicyId),
          commercialPolicyKey('provider', tenantId, providerPolicyId, providerId),
        ],
        'shared',
      );
      result = await tx.query<Row>(selectSql, values);
      if (result.rows.length > 1) fail('STORAGE_ERROR', 'dispatchable route authority is ambiguous');
      const row = result.rows[0];
      if (!row) return null;
      return {
        tenantId: text(row.tenant_id, 'tenant_id'),
        projectId: text(row.project_id, 'project_id'),
        routeId: text(row.route_id, 'route_id'),
        routeVersion: version(row.version, 'version'),
        customerPolicyId: text(row.customer_policy_id, 'customer_policy_id'),
        customerPolicyVersion: version(row.customer_policy_version, 'customer_policy_version'),
        providerPolicyId: text(row.provider_policy_id, 'provider_policy_id'),
        providerPolicyVersion: version(row.provider_policy_version, 'provider_policy_version'),
        contractAttestationId: text(row.contract_attestation_id, 'contract_attestation_id'),
        customerPriceVersion:
          row.customer_price_version === null || row.customer_price_version === undefined
            ? null
            : text(row.customer_price_version, 'customer_price_version'),
        supplierCostVersion:
          row.supplier_cost_version === null || row.supplier_cost_version === undefined
            ? null
            : text(row.supplier_cost_version, 'supplier_cost_version'),
      };
    };
    try {
      return input.executor ? await run(input.executor) : await this.database.transaction(run);
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', 'dispatchable commercial route could not be resolved', error);
    }
  }

  private async createPolicy<TDefinition extends CustomerMeteringPolicyDefinition | ProviderMeteringPolicyDefinition>(
    input: CreateCommercialMeteringPolicyInput<TDefinition>,
    kind: CommercialMeteringPolicyKind,
  ): Promise<CommercialMeteringPolicyRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const policyId = text(input?.policyId, 'policyId', 255);
    const definition = (
      kind === 'customer'
        ? normalizeCustomerDefinition(input.definition as CustomerMeteringPolicyDefinition)
        : normalizeProviderDefinition(input.definition as ProviderMeteringPolicyDefinition)
    ) as TDefinition;
    const audit = normalizeAudit(input?.audit);
    const now = nowString(this.options.now ?? (() => new Date()));
    try {
      return await this.database.transaction(async (tx) => {
        const table = kind === 'customer' ? 'customer' : 'provider';
        const providerId =
          kind === 'provider'
            ? text((definition as ProviderMeteringPolicyDefinition).providerId, 'providerId', 255)
            : undefined;
        await lockCommercialScope(
          tx,
          tenantId,
          projectId,
          audit.actorUserId,
          commercialPolicyKeys(kind, tenantId, policyId, providerId === undefined ? [] : [providerId]),
          'exclusive',
        );
        const existing = await tx.query<Row>(
          `SELECT policy_id FROM saas_${table}_metering_policy_heads
           WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3
           LIMIT 2 FOR UPDATE`,
          [tenantId, projectId, policyId],
        );
        if (existing.rows.length > 1) fail('STORAGE_ERROR', 'policy head is ambiguous');
        if (existing.rows.length === 1) fail('INVALID_LIFECYCLE', 'policy already exists');
        await tx.query(
          `INSERT INTO saas_${table}_metering_policy_versions
             (${policyInsertColumns(kind)})
           VALUES (${policyInsertValues(tenantId, projectId, policyId, definition, '1', 'draft', audit.actorUserId, now)
             .map((_value, index) => `$${index + 1}`)
             .join(', ')})`,
          policyInsertValues(tenantId, projectId, policyId, definition, '1', 'draft', audit.actorUserId, now),
        );
        await tx.query(
          `INSERT INTO saas_${table}_metering_policy_heads
             (tenant_id, project_id, policy_id, current_version, status, changed_by_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6, $6)`,
          [tenantId, projectId, policyId, '1', audit.actorUserId, now],
        );
        await auditSql(
          tx,
          tenantId,
          audit,
          `commercial_metering.${kind}_policy_created`,
          `${projectId}:${policyId}:1`,
          now,
        );
        return policyRecordFromDefinition(
          tenantId,
          projectId,
          policyId,
          definition,
          '1',
          'draft',
          audit.actorUserId,
          now,
        );
      });
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', `${kind} metering policy could not be created`, error);
    }
  }

  private async publishPolicy<TDefinition extends CustomerMeteringPolicyDefinition | ProviderMeteringPolicyDefinition>(
    input: PublishCommercialMeteringPolicyInput<TDefinition>,
    kind: CommercialMeteringPolicyKind,
  ): Promise<CommercialMeteringPolicyRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const policyId = text(input?.policyId, 'policyId', 255);
    const expectedVersion = version(input?.expectedVersion, 'expectedVersion');
    const audit = normalizeAudit(input?.audit);
    const supplied = input.definition
      ? ((kind === 'customer'
          ? normalizeCustomerDefinition(input.definition as CustomerMeteringPolicyDefinition)
          : normalizeProviderDefinition(input.definition as ProviderMeteringPolicyDefinition)) as TDefinition)
      : null;
    const now = nowString(this.options.now ?? (() => new Date()));
    try {
      return await this.database.transaction(async (tx) => {
        const table = kind === 'customer' ? 'customer' : 'provider';
        const hintHead = await this.getPolicyHead(tx, tenantId, projectId, policyId, kind, false);
        if (!hintHead) fail('NOT_FOUND', 'policy head was not found');
        const hintVersion = version(hintHead.current_version, 'current policy version');
        const hintPolicy = await this.getPolicyRow(tx, tenantId, projectId, policyId, hintVersion, kind);
        if (!hintPolicy) fail('STORAGE_ERROR', 'current policy version is missing');
        const hintProviderId = kind === 'provider' ? text(hintPolicy.provider_id, 'provider_id', 255) : undefined;
        const suppliedProviderId =
          kind === 'provider'
            ? text((supplied as ProviderMeteringPolicyDefinition | null)?.providerId, 'providerId', 255)
            : undefined;
        await lockCommercialScope(
          tx,
          tenantId,
          projectId,
          audit.actorUserId,
          commercialPolicyKeys(
            kind,
            tenantId,
            policyId,
            [hintProviderId, suppliedProviderId].filter((value): value is string => value !== undefined),
          ),
          'exclusive',
        );
        const headResult = await this.getPolicyHead(tx, tenantId, projectId, policyId, kind, true);
        if (!headResult) fail('NOT_FOUND', 'policy head was not found');
        const head = headResult;
        if (version(head.current_version, 'current policy version') !== expectedVersion)
          fail('CAS_CONFLICT', 'policy version conflict');
        if (status(head.status) === 'disabled' && !supplied)
          fail('INVALID_LIFECYCLE', 'disabled policy cannot be reactivated without a definition');
        let definition = supplied;
        if (!definition) {
          const current = await tx.query<Row>(
            `SELECT * FROM saas_${table}_metering_policy_versions
             WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3 AND version = $4
             LIMIT 2`,
            [tenantId, projectId, policyId, expectedVersion],
          );
          if (current.rows.length !== 1 || !current.rows[0])
            fail('STORAGE_ERROR', 'policy version is missing or ambiguous');
          definition = rowDefinition(current.rows[0], kind) as TDefinition;
        }
        const nextVersion = version(BigInt(expectedVersion) + 1n, 'next policy version');
        await tx.query(
          `INSERT INTO saas_${table}_metering_policy_versions
             (${policyInsertColumns(kind)})
           VALUES (${policyInsertValues(
             tenantId,
             projectId,
             policyId,
             definition,
             nextVersion,
             'active',
             audit.actorUserId,
             now,
           )
             .map((_value, index) => `$${index + 1}`)
             .join(', ')})`,
          policyInsertValues(tenantId, projectId, policyId, definition, nextVersion, 'active', audit.actorUserId, now),
        );
        const updated = await tx.query<PolicyHeadRow>(
          `UPDATE saas_${table}_metering_policy_heads
           SET current_version = $4, status = 'active', changed_by_user_id = $5, updated_at = $6
           WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3
             AND current_version = $7 AND status = $8
           RETURNING tenant_id, project_id, policy_id, current_version, status`,
          [tenantId, projectId, policyId, nextVersion, audit.actorUserId, now, expectedVersion, head.status],
        );
        if (updated.rows.length !== 1) fail('CAS_CONFLICT', 'policy version conflict');
        await auditSql(
          tx,
          tenantId,
          audit,
          `commercial_metering.${kind}_policy_published`,
          `${projectId}:${policyId}:${nextVersion}`,
          now,
        );
        return policyRecordFromDefinition(
          tenantId,
          projectId,
          policyId,
          definition,
          nextVersion,
          'active',
          audit.actorUserId,
          now,
        );
      });
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', `${kind} metering policy could not be published`, error);
    }
  }

  private async setPolicyStatus(
    input: DisableCommercialMeteringPolicyInput,
    kind: CommercialMeteringPolicyKind,
    nextStatus: 'disabled',
  ): Promise<CommercialMeteringPolicyRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const policyId = text(input?.policyId, 'policyId', 255);
    const expectedVersion = version(input?.expectedVersion, 'expectedVersion');
    const audit = normalizeAudit(input?.audit);
    const now = nowString(this.options.now ?? (() => new Date()));
    try {
      return await this.database.transaction(async (tx) => {
        const table = kind === 'customer' ? 'customer' : 'provider';
        const hintHead = await this.getPolicyHead(tx, tenantId, projectId, policyId, kind, false);
        if (!hintHead) fail('NOT_FOUND', 'policy head was not found');
        const hintVersion = version(hintHead.current_version, 'current policy version');
        const hintPolicy = await this.getPolicyRow(tx, tenantId, projectId, policyId, hintVersion, kind);
        if (!hintPolicy) fail('STORAGE_ERROR', 'current policy version is missing');
        const hintProviderId = kind === 'provider' ? text(hintPolicy.provider_id, 'provider_id', 255) : undefined;
        await lockCommercialScope(
          tx,
          tenantId,
          projectId,
          audit.actorUserId,
          commercialPolicyKeys(kind, tenantId, policyId, hintProviderId === undefined ? [] : [hintProviderId]),
          'exclusive',
        );
        const head = await this.getPolicyHead(tx, tenantId, projectId, policyId, kind, true);
        if (!head) fail('NOT_FOUND', 'policy head was not found');
        if (version(head.current_version, 'current policy version') !== expectedVersion)
          fail('CAS_CONFLICT', 'policy version conflict');
        if (status(head.status) === 'disabled') fail('INVALID_LIFECYCLE', 'policy is already disabled');
        const current = await tx.query<Row>(
          `SELECT * FROM saas_${table}_metering_policy_versions
           WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3 AND version = $4
           LIMIT 2`,
          [tenantId, projectId, policyId, expectedVersion],
        );
        if (current.rows.length !== 1 || !current.rows[0])
          fail('STORAGE_ERROR', 'policy version is missing or ambiguous');
        const definition = rowDefinition(current.rows[0], kind);
        const nextVersion = version(BigInt(expectedVersion) + 1n, 'next policy version');
        await tx.query(
          `INSERT INTO saas_${table}_metering_policy_versions
             (${policyInsertColumns(kind)})
           VALUES (${policyInsertValues(
             tenantId,
             projectId,
             policyId,
             definition,
             nextVersion,
             nextStatus,
             audit.actorUserId,
             now,
           )
             .map((_value, index) => `$${index + 1}`)
             .join(', ')})`,
          policyInsertValues(
            tenantId,
            projectId,
            policyId,
            definition,
            nextVersion,
            nextStatus,
            audit.actorUserId,
            now,
          ),
        );
        const updated = await tx.query<PolicyHeadRow>(
          `UPDATE saas_${table}_metering_policy_heads
           SET current_version = $4, status = $5, changed_by_user_id = $6, updated_at = $7
           WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3
             AND current_version = $8 AND status = $9
           RETURNING tenant_id, project_id, policy_id, current_version, status`,
          [
            tenantId,
            projectId,
            policyId,
            nextVersion,
            nextStatus,
            audit.actorUserId,
            now,
            expectedVersion,
            head.status,
          ],
        );
        if (updated.rows.length !== 1) fail('CAS_CONFLICT', 'policy version conflict');
        await auditSql(
          tx,
          tenantId,
          audit,
          `commercial_metering.${kind}_policy_disabled`,
          `${projectId}:${policyId}:${nextVersion}`,
          now,
        );
        return policyRecordFromDefinition(
          tenantId,
          projectId,
          policyId,
          definition,
          nextVersion,
          nextStatus,
          audit.actorUserId,
          now,
        );
      });
    } catch (error) {
      if (error instanceof SaasCommercialMeteringPolicyError) throw error;
      fail('STORAGE_ERROR', `${kind} metering policy could not be disabled`, error);
    }
  }

  private async getPolicyRow(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    policyId: string,
    policyVersion: string,
    kind: CommercialMeteringPolicyKind,
  ): Promise<Row | null> {
    const table = kind === 'customer' ? 'customer' : 'provider';
    const result = await tx.query<Row>(
      `SELECT * FROM saas_${table}_metering_policy_versions
       WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3 AND version = $4
       LIMIT 2`,
      [tenantId, projectId, policyId, policyVersion],
    );
    if (result.rows.length > 1) fail('STORAGE_ERROR', `${kind} policy version is ambiguous`);
    return result.rows[0] ?? null;
  }

  private async getPolicyHead(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    policyId: string,
    kind: CommercialMeteringPolicyKind,
    forUpdate: boolean,
  ): Promise<PolicyHeadRow | null> {
    const table = kind === 'customer' ? 'customer' : 'provider';
    const result = await tx.query<PolicyHeadRow>(
      `SELECT tenant_id, project_id, policy_id, current_version, status
       FROM saas_${table}_metering_policy_heads
       WHERE tenant_id = $1 AND project_id = $2 AND policy_id = $3
       LIMIT 2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, projectId, policyId],
    );
    if (result.rows.length > 1) fail('STORAGE_ERROR', 'policy head is ambiguous');
    return result.rows[0] ?? null;
  }

  private assertAttestationMatchesPolicy(
    input: ContractTestAttestationInput,
    policy: ProviderMeteringPolicyDefinition,
    providerPolicyVersion: string,
  ): void {
    if (
      input.publicModelId !== policy.publicModelId ||
      version(input.publicModelVersion, 'publicModelVersion') !==
        version(policy.publicModelVersion, 'publicModelVersion') ||
      input.protocol !== policy.protocol ||
      input.endpoint !== policy.endpoint ||
      input.supplyMode !== policy.supplyMode ||
      input.targetMode !== policy.targetMode ||
      input.providerPolicyId.trim() === '' ||
      version(input.providerPolicyVersion, 'providerPolicyVersion') !== providerPolicyVersion ||
      JSON.stringify(input.usageDimensions) !== JSON.stringify(policy.usageDimensions) ||
      input.tokenSource !== policy.tokenSource ||
      input.roundingVersion !== policy.roundingVersion ||
      input.roundingMode !== policy.roundingMode
    ) {
      fail('ATTESTATION_INVALID', 'contract attestation does not match provider metering policy');
    }
  }

  private verifyAttestation(input: ContractTestAttestationInput, providerPolicyVersion: string): void {
    const expectedVector = keyValue(this.options.trustedTestVectorDigests, input.suiteVersion);
    if (!expectedVector) fail('ATTESTATION_VECTOR_MISMATCH', 'no trusted test vector is configured');
    if (expectedVector !== input.testVectorDigest)
      fail('ATTESTATION_VECTOR_MISMATCH', 'test vector digest is not trusted');
    const key = keyValue(this.options.trustedVerifierPublicKeys, input.verifierKeyId);
    if (!key) fail('ATTESTATION_UNKNOWN_KEY', 'verifier key is not trusted');
    let publicKey: KeyObject;
    try {
      publicKey = key instanceof Object && 'type' in key ? (key as KeyObject) : createPublicKey(key);
    } catch (error) {
      fail('ATTESTATION_UNKNOWN_KEY', 'trusted verifier key is invalid', error);
    }
    const payload = attestationPayloadFromInput(input, providerPolicyVersion);
    let valid = false;
    try {
      valid = verifySignature(
        null,
        Buffer.from(canonicalContractAttestationPayload(payload), 'utf8'),
        publicKey,
        Buffer.from(input.signatureBase64, 'base64'),
      );
    } catch (error) {
      fail('ATTESTATION_BAD_SIGNATURE', 'contract attestation signature could not be verified', error);
    }
    if (!valid) fail('ATTESTATION_BAD_SIGNATURE', 'contract attestation signature is invalid');
  }
}
