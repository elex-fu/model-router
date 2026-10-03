import { isUtf8 } from 'node:buffer';
import {
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
} from '../credentials/provider-crypto.js';
import type { PreparedEvidenceTransportResponse } from '../gateway/prepared-evidence-dispatch-service.js';
import type {
  ProviderHttpCredential,
  ProviderHttpCredentialResolveInput,
  ProviderHttpCredentialResolver,
} from '../gateway/provider-http-transport.js';
import { ProviderHttpTransportError } from '../gateway/provider-http-transport.js';
import type {
  ProviderCredentialDispatchBinding,
  ProviderCredentialDispatchProof,
  ProviderCredentialDispatchProofReader,
} from '../supply/types.js';
import type { GatewayProviderCredentialUnsealer } from './gateway-provider-credential-unsealer.js';

const DEFAULT_ALLOWED_AUTHENTICATION_HEADERS = Object.freeze([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_AUTHENTICATION_VALUE_BYTES = 16 * 1024;
const BEARER_PREFIX = Buffer.from('Bearer ', 'ascii');

const SAFE_MESSAGES = Object.freeze({
  INVALID_INPUT: 'provider HTTP credential resolver input is invalid',
  CREDENTIAL_INVALID: 'provider HTTP credential injection is invalid',
  CREDENTIAL_UNAVAILABLE: 'provider HTTP credential is unavailable',
});

export type ProviderSupplyHttpCredentialResolverErrorCode = keyof typeof SAFE_MESSAGES;

export class ProviderSupplyHttpCredentialResolverError extends ProviderHttpTransportError {
  constructor(readonly code: ProviderSupplyHttpCredentialResolverErrorCode) {
    super(code, SAFE_MESSAGES[code]);
    this.name = 'ProviderSupplyHttpCredentialResolverError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ProviderSupplyHttpCredentialProofReader = ProviderCredentialDispatchProofReader;

/** Compatibility type retained for callers that reference the former service shape. */
export interface ProviderSupplyHttpCredentialService {
  withProviderCredential<T>(
    grant: { readonly evidenceId: string },
    callback: (secret: Buffer) => T | PromiseLike<T>,
  ): Promise<T>;
}

export type ProviderSupplyHttpAuthenticationHeader =
  | string
  | (Pick<ProviderHttpCredential, 'headerName'> & { readonly valueFormat?: 'raw' | 'bearer' });

export type ProviderSupplyHttpAuthenticationHeaderResolver = (
  input: ProviderHttpCredentialResolveInput,
) => ProviderSupplyHttpAuthenticationHeader | PromiseLike<ProviderSupplyHttpAuthenticationHeader>;

export interface ProviderSupplyHttpCredentialResolverOptions {
  readonly proofReader: ProviderSupplyHttpCredentialProofReader;
  readonly unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'>;
  /**
   * Deployment-owned header/format policy, never supplied by a request.
   * Authorization defaults to bearer; other headers default to raw. Stored
   * complete header values require explicit raw; plaintext is never inspected
   * for, or stripped of, an existing authentication prefix.
   */
  readonly resolveAuthenticationHeader: ProviderSupplyHttpAuthenticationHeaderResolver;
  readonly allowedAuthenticationHeaders?: readonly string[];
  readonly now?: () => Date;
}

const DISPATCH_BINDING_KEYS = [
  'tenantId',
  'requestId',
  'attemptId',
  'attemptOrdinal',
  'supplyMode',
  'accountOwnerKind',
  'accountId',
  'providerId',
  'productId',
  'protocol',
  'endpoint',
  'routeConfigId',
  'routeConfigVersion',
  'routePublicModelId',
  'routePublicModelVersion',
  'routeProtocol',
  'routeTargetMode',
  'routeUpstreamId',
  'upstreamId',
  'resolvedModel',
  'dispatchProfileId',
  'supplyProfileAuthzVersion',
  'credentialId',
  'credentialVersion',
  'credentialAuthzVersion',
  'accountAuthzVersion',
  'profileAccountAuthzVersion',
  'poolId',
  'poolAuthzVersion',
  'poolMemberAccountAuthzVersion',
  'poolMemberAuthzVersion',
  'poolGrantAuthzVersion',
  'poolGrantProfileAuthzVersion',
  'poolGrantPoolAuthzVersion',
] as const satisfies readonly (keyof ProviderCredentialDispatchBinding)[];

function fail(code: ProviderSupplyHttpCredentialResolverErrorCode): never {
  throw new ProviderSupplyHttpCredentialResolverError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function evidenceIdFromInput(input: ProviderHttpCredentialResolveInput): string {
  if (!isRecord(input) || typeof input.evidenceId !== 'string') fail('INVALID_INPUT');
  const evidenceId = input.evidenceId.trim();
  if (evidenceId === '' || evidenceId !== input.evidenceId || evidenceId.includes('\u0000')) fail('INVALID_INPUT');
  return evidenceId;
}

function credentialVersionFromInput(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) fail('CREDENTIAL_UNAVAILABLE');
  const version = Number(value);
  if (!Number.isSafeInteger(version) || String(version) !== value) fail('CREDENTIAL_UNAVAILABLE');
  return version;
}

function authenticationFromValue(
  value: unknown,
  allowedAuthenticationHeaders: ReadonlySet<string>,
): { readonly headerName: string; readonly valueFormat: 'raw' | 'bearer' } {
  let raw: unknown = value;
  let format: unknown;
  if (typeof value !== 'string') {
    try {
      if (!isRecord(value)) fail('CREDENTIAL_INVALID');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (
        !keys.every((key) => key === 'headerName' || key === 'valueFormat') ||
        !descriptors.headerName || !Object.hasOwn(descriptors.headerName, 'value') ||
        (descriptors.valueFormat !== undefined && !Object.hasOwn(descriptors.valueFormat, 'value'))
      ) fail('CREDENTIAL_INVALID');
      raw = descriptors.headerName.value;
      format = descriptors.valueFormat?.value;
    } catch {
      fail('CREDENTIAL_INVALID');
    }
  }
  if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw)) fail('CREDENTIAL_INVALID');
  const headerName = raw.trim().toLowerCase();
  if (!HEADER_NAME.test(headerName) || !allowedAuthenticationHeaders.has(headerName)) fail('CREDENTIAL_INVALID');
  const valueFormat = format === undefined ? headerName === 'authorization' ? 'bearer' : 'raw' : format;
  if ((valueFormat !== 'raw' && valueFormat !== 'bearer') || (valueFormat === 'bearer' && headerName !== 'authorization'))
    fail('CREDENTIAL_INVALID');
  return { headerName, valueFormat };
}

function formattedCredential(secret: Buffer, format: 'raw' | 'bearer'): Buffer {
  const prefixBytes = format === 'bearer' ? BEARER_PREFIX.byteLength : 0;
  if (secret.byteLength === 0 || secret.byteLength + prefixBytes > MAX_AUTHENTICATION_VALUE_BYTES || !isUtf8(secret))
    fail('CREDENTIAL_INVALID');
  for (const byte of secret) if (byte <= 0x1f || byte === 0x7f) fail('CREDENTIAL_INVALID');
  if (format === 'raw') return secret;
  const formatted = Buffer.alloc(prefixBytes + secret.byteLength);
  BEARER_PREFIX.copy(formatted);
  secret.copy(formatted, prefixBytes);
  return formatted;
}

function assertActive(input: ProviderHttpCredentialResolveInput): void {
  if (!input.signal || typeof input.signal.aborted !== 'boolean') fail('INVALID_INPUT');
  if (input.signal.aborted) fail('CREDENTIAL_UNAVAILABLE');
}

function normalizeAllowedAuthenticationHeaders(value: readonly string[] | undefined): ReadonlySet<string> {
  const headers = value ?? DEFAULT_ALLOWED_AUTHENTICATION_HEADERS;
  if (!Array.isArray(headers) || headers.length === 0) fail('INVALID_INPUT');
  const normalized = new Set<string>();
  for (const header of headers) {
    if (typeof header !== 'string' || header.trim() === '' || /[\x00-\x1f\x7f]/.test(header)) fail('INVALID_INPUT');
    const normalizedHeader = header.trim().toLowerCase();
    if (!HEADER_NAME.test(normalizedHeader)) fail('INVALID_INPUT');
    normalized.add(normalizedHeader);
  }
  return normalized;
}

function isTransportResponse(value: unknown): value is PreparedEvidenceTransportResponse {
  return isRecord(value) && typeof value.responseStarted === 'boolean';
}

function sameDispatchBinding(
  left: ProviderCredentialDispatchProof['evidence'],
  right: ProviderCredentialDispatchProof['attempt'],
): boolean {
  return DISPATCH_BINDING_KEYS.every((key) => left[key] === right[key]);
}

function validAfter(value: string, now: Date): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function validWindow(effectiveAt: string, expiresAt: string | null, now: Date): boolean {
  const effective = new Date(effectiveAt).getTime();
  const expires = expiresAt === null ? null : new Date(expiresAt).getTime();
  return (
    Number.isFinite(effective) &&
    effective <= now.getTime() &&
    (expires === null || (Number.isFinite(expires) && expires > now.getTime()))
  );
}

function ownerMatches(
  owner: { readonly ownerKind: string; readonly tenantId: string | null; readonly supplyMode: string },
  binding: ProviderCredentialDispatchProof['evidence'],
): boolean {
  return (
    owner.ownerKind === binding.accountOwnerKind &&
    owner.supplyMode === binding.supplyMode &&
    owner.tenantId === (binding.accountOwnerKind === 'tenant' ? binding.tenantId : null)
  );
}

function assertAuthorizedProof(
  proof: ProviderCredentialDispatchProof,
  input: ProviderHttpCredentialResolveInput,
  expectedEvidenceId: string,
  expectedCredentialVersion: number,
  now: Date,
): void {
  if (
    !isRecord(proof) ||
    !proof.evidence ||
    !proof.attempt ||
    !proof.account ||
    !proof.credential ||
    !proof.version ||
    !proof.profile ||
    !proof.claimAudit
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }

  const { evidence, attempt, account, credential, version, profile, profileAccount, pool, poolMember, poolGrant } =
    proof;
  if (
    evidence.evidenceId !== expectedEvidenceId ||
    evidence.tenantId !== input.tenantId ||
    evidence.requestId !== input.requestId ||
    evidence.attemptId !== input.attemptId ||
    evidence.claimedAttemptId !== input.attemptId ||
    evidence.accountId !== input.accountId ||
    evidence.upstreamId !== input.upstreamId ||
    evidence.credentialId !== input.credentialId ||
    evidence.credentialVersion !== expectedCredentialVersion ||
    evidence.status !== 'claimed' ||
    attempt.attemptId !== input.attemptId ||
    attempt.preparedEvidenceId !== expectedEvidenceId ||
    attempt.dispatchAuthorityState !== 'bound' ||
    attempt.dispatchState !== 'dispatching' ||
    attempt.resultState !== 'pending' ||
    attempt.responseStarted ||
    !sameDispatchBinding(evidence, attempt) ||
    proof.claimAudit.action !== 'saas_prepared_request_evidence.claimed' ||
    proof.claimAudit.targetType !== 'saas_prepared_request_evidence' ||
    proof.claimAudit.targetId !== expectedEvidenceId ||
    evidence.supplyProfileId !== profile.id ||
    evidence.supplyProfileVersion !== evidence.supplyProfileAuthzVersion ||
    !validAfter(evidence.dispatchDeadline, now) ||
    !validAfter(evidence.expiresAt, now)
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }

  if (
    profile.tenantId !== evidence.tenantId ||
    profile.supplyMode !== evidence.supplyMode ||
    profile.status !== 'active' ||
    profile.authzVersion !== evidence.supplyProfileAuthzVersion ||
    !ownerMatches(account, evidence) ||
    account.id !== evidence.accountId ||
    account.providerId !== evidence.providerId ||
    account.productId !== evidence.productId ||
    account.status !== 'active' ||
    account.validationState !== 'verified' ||
    account.authzVersion !== evidence.accountAuthzVersion ||
    !ownerMatches(credential, evidence) ||
    credential.id !== evidence.credentialId ||
    credential.accountId !== evidence.accountId ||
    credential.providerId !== evidence.providerId ||
    credential.productId !== evidence.productId ||
    credential.status !== 'active' ||
    credential.validationState !== 'verified' ||
    credential.currentVersion !== expectedCredentialVersion ||
    credential.authzVersion !== evidence.credentialAuthzVersion ||
    (credential.expiresAt !== null && !validAfter(credential.expiresAt, now)) ||
    version.ownerKind !== evidence.accountOwnerKind ||
    version.tenantId !== (evidence.accountOwnerKind === 'tenant' ? evidence.tenantId : null) ||
    (version.ownerKind === 'tenant' ? 'byok' : 'platform') !== evidence.supplyMode ||
    version.accountId !== evidence.accountId ||
    version.credentialId !== evidence.credentialId ||
    version.version !== expectedCredentialVersion ||
    version.status !== 'active' ||
    version.retiredAt !== null ||
    version.revokedAt !== null ||
    (version.expiresAt !== null && !validAfter(version.expiresAt, now)) ||
    version.kmsPurpose !== account.purpose ||
    version.kmsKeyId !== version.envelope.kmsKeyId ||
    version.envelopeSchemaVersion !== version.envelope.schemaVersion ||
    version.contextVersion !== version.envelope.contextVersion ||
    version.algorithm !== version.envelope.algorithm ||
    version.envelopeSchemaVersion !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
    version.contextVersion !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
    version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }

  if (evidence.supplyMode === 'byok') {
    if (
      evidence.accountOwnerKind !== 'tenant' ||
      evidence.routeTargetMode !== 'tenant_account' ||
      profileAccount === null ||
      pool !== null ||
      poolMember !== null ||
      poolGrant !== null ||
      profileAccount.tenantId !== evidence.tenantId ||
      profileAccount.supplyProfileId !== evidence.dispatchProfileId ||
      profileAccount.supplyMode !== 'byok' ||
      profileAccount.accountId !== evidence.accountId ||
      profileAccount.providerId !== evidence.providerId ||
      profileAccount.productId !== evidence.productId ||
      profileAccount.status !== 'active' ||
      profileAccount.accountAuthzVersion !== evidence.accountAuthzVersion ||
      profileAccount.authzVersion !== evidence.profileAccountAuthzVersion ||
      !validWindow(profileAccount.effectiveAt, profileAccount.expiresAt, now)
    ) {
      fail('CREDENTIAL_UNAVAILABLE');
    }
  } else if (
    evidence.accountOwnerKind !== 'platform' ||
    evidence.routeTargetMode !== 'platform_pool' ||
    profileAccount !== null ||
    pool === null ||
    poolMember === null ||
    poolGrant === null ||
    pool.id !== evidence.poolId ||
    pool.providerId !== evidence.providerId ||
    pool.productId !== evidence.productId ||
    pool.status !== 'active' ||
    pool.validationState !== 'verified' ||
    pool.authzVersion !== evidence.poolAuthzVersion ||
    poolMember.poolId !== evidence.poolId ||
    poolMember.accountId !== evidence.accountId ||
    poolMember.providerId !== evidence.providerId ||
    poolMember.productId !== evidence.productId ||
    poolMember.status !== 'active' ||
    poolMember.accountAuthzVersion !== evidence.accountAuthzVersion ||
    poolMember.authzVersion !== evidence.poolMemberAuthzVersion ||
    poolGrant.poolId !== evidence.poolId ||
    poolGrant.tenantId !== evidence.tenantId ||
    poolGrant.supplyProfileId !== evidence.dispatchProfileId ||
    poolGrant.supplyMode !== 'platform' ||
    poolGrant.status !== 'active' ||
    poolGrant.profileAuthzVersion !== evidence.poolGrantProfileAuthzVersion ||
    poolGrant.poolAuthzVersion !== evidence.poolGrantPoolAuthzVersion ||
    poolGrant.authzVersion !== evidence.poolGrantAuthzVersion ||
    !validWindow(poolGrant.effectiveAt, poolGrant.expiresAt, now)
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }
}

/**
 * Bridges the database-owned evidence snapshot to gateway credential
 * unsealing and the provider HTTP authentication callback.
 */
export class ProviderSupplyHttpCredentialResolver {
  readonly resolveCredential: ProviderHttpCredentialResolver;
  private readonly proofReader: ProviderSupplyHttpCredentialProofReader;
  private readonly unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'>;
  private readonly resolveAuthenticationHeader: ProviderSupplyHttpAuthenticationHeaderResolver;
  private readonly allowedAuthenticationHeaders: ReadonlySet<string>;
  private readonly now: () => Date;

  constructor(options: ProviderSupplyHttpCredentialResolverOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !options.proofReader ||
      typeof options.proofReader.readDispatchProof !== 'function' ||
      !options.unsealer ||
      typeof options.unsealer.withCredential !== 'function'
    ) {
      fail('INVALID_INPUT');
    }
    if (typeof options.resolveAuthenticationHeader !== 'function') fail('INVALID_INPUT');
    this.proofReader = options.proofReader;
    this.unsealer = options.unsealer;
    this.resolveAuthenticationHeader = options.resolveAuthenticationHeader;
    this.allowedAuthenticationHeaders = normalizeAllowedAuthenticationHeaders(options.allowedAuthenticationHeaders);
    this.now = options.now ?? (() => new Date());
    this.resolveCredential = this.resolveCredentialFor.bind(this);
    Object.freeze(this);
  }

  async resolveCredentialFor(
    input: ProviderHttpCredentialResolveInput,
    useCredential: Parameters<ProviderHttpCredentialResolver>[1],
  ): Promise<PreparedEvidenceTransportResponse> {
    let callbackContractError: ProviderSupplyHttpCredentialResolverError | undefined;
    let callbacksOpen = false;
    let activeSecret: Buffer | undefined;
    let activeFormatted: Buffer | undefined;
    try {
      const evidenceId = evidenceIdFromInput(input);
      if (typeof useCredential !== 'function') fail('INVALID_INPUT');
      const credentialVersion = credentialVersionFromInput(input.credentialVersion);
      assertActive(input);

      // Resolve the deployment-owned header before reading proof or unsealing.
      const authentication = authenticationFromValue(
        await this.resolveAuthenticationHeader(input),
        this.allowedAuthenticationHeaders,
      );
      assertActive(input);
      const proof = await this.proofReader.readDispatchProof(evidenceId);
      assertActive(input);
      if (!proof) fail('CREDENTIAL_UNAVAILABLE');
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('CREDENTIAL_UNAVAILABLE');
      assertAuthorizedProof(proof, input, evidenceId, credentialVersion, now);

      let injectionCount = 0;
      let response: PreparedEvidenceTransportResponse | undefined;
      callbacksOpen = true;
      try {
        await this.unsealer.withCredential(
          { account: proof.account, credential: proof.credential, version: proof.version },
          async (secret) => {
            const candidateSecret: unknown = secret;
            if (!Buffer.isBuffer(candidateSecret)) {
              if (candidateSecret instanceof Uint8Array) candidateSecret.fill(0);
              callbackContractError = new ProviderSupplyHttpCredentialResolverError('CREDENTIAL_INVALID');
              throw callbackContractError;
            }
            if (!callbacksOpen || injectionCount !== 0) {
              injectionCount += 1;
              candidateSecret.fill(0);
              callbackContractError = new ProviderSupplyHttpCredentialResolverError('CREDENTIAL_INVALID');
              throw callbackContractError;
            }
            injectionCount += 1;
            activeSecret = candidateSecret;
            try {
              assertActive(input);
              activeFormatted = formattedCredential(candidateSecret, authentication.valueFormat);
              const candidate = await useCredential({ headerName: authentication.headerName, value: activeFormatted });
              assertActive(input);
              if (!callbacksOpen) fail('CREDENTIAL_INVALID');
              if (!isTransportResponse(candidate)) {
                callbackContractError = new ProviderSupplyHttpCredentialResolverError('CREDENTIAL_INVALID');
                throw callbackContractError;
              }
              response = candidate;
              return candidate;
            } catch (error) {
              if (error instanceof ProviderSupplyHttpCredentialResolverError) callbackContractError ??= error;
              throw error;
            } finally {
              activeFormatted?.fill(0);
              candidateSecret.fill(0);
            }
          },
        );
      } finally {
        callbacksOpen = false;
      }

      if (callbackContractError) throw callbackContractError;
      assertActive(input);
      if (injectionCount !== 1 || response === undefined) fail('CREDENTIAL_UNAVAILABLE');
      return response;
    } catch (error) {
      if (callbackContractError) throw callbackContractError;
      if (error instanceof ProviderSupplyHttpCredentialResolverError) throw error;
      throw new ProviderSupplyHttpCredentialResolverError('CREDENTIAL_UNAVAILABLE');
    } finally {
      callbacksOpen = false;
      activeFormatted?.fill(0);
      activeSecret?.fill(0);
    }
  }
}

export function createProviderSupplyHttpCredentialResolver(
  options: ProviderSupplyHttpCredentialResolverOptions,
): ProviderHttpCredentialResolver {
  return new ProviderSupplyHttpCredentialResolver(options).resolveCredential;
}
